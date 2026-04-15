import { isWorkspaceType } from "./drive-api.js";
import { loadIgnoreRules } from "./ignore.js";
import { loadPackManifest } from "./config.js";

export const ChangeType = Object.freeze({
  REMOTE_ADDED: "remote_added",
  REMOTE_MODIFIED: "remote_modified",
  REMOTE_DELETED: "remote_deleted",
  LOCAL_ADDED: "local_added",
  LOCAL_MODIFIED: "local_modified",
  LOCAL_DELETED: "local_deleted",
  CONFLICT: "conflict",
  // Pack-specific change types
  PACK_LOCAL_MODIFIED: "pack_local_modified",
  PACK_REMOTE_MODIFIED: "pack_remote_modified",
  PACK_SYNCED: "pack_synced",
  PACK_CONFLICT: "pack_conflict",
  PACK_NEW: "pack_new",
});

const SHORT_STATUS = {
  [ChangeType.REMOTE_ADDED]: "+R",
  [ChangeType.REMOTE_MODIFIED]: "MR",
  [ChangeType.REMOTE_DELETED]: "-R",
  [ChangeType.LOCAL_ADDED]: "+L",
  [ChangeType.LOCAL_MODIFIED]: "ML",
  [ChangeType.LOCAL_DELETED]: "-L",
  [ChangeType.CONFLICT]: "!!",
  [ChangeType.PACK_LOCAL_MODIFIED]: "PL",
  [ChangeType.PACK_REMOTE_MODIFIED]: "PR",
  [ChangeType.PACK_SYNCED]: "P=",
  [ChangeType.PACK_CONFLICT]: "P!",
  [ChangeType.PACK_NEW]: "P+",
};

const DESCRIPTION = {
  [ChangeType.REMOTE_ADDED]: "new on Drive",
  [ChangeType.REMOTE_MODIFIED]: "modified on Drive",
  [ChangeType.REMOTE_DELETED]: "deleted on Drive",
  [ChangeType.LOCAL_ADDED]: "new locally",
  [ChangeType.LOCAL_MODIFIED]: "modified locally",
  [ChangeType.LOCAL_DELETED]: "deleted locally",
  [ChangeType.CONFLICT]: "both sides changed",
  [ChangeType.PACK_LOCAL_MODIFIED]: "pack changed locally",
  [ChangeType.PACK_REMOTE_MODIFIED]: "pack changed on Drive",
  [ChangeType.PACK_SYNCED]: "pack up to date",
  [ChangeType.PACK_CONFLICT]: "pack conflict",
  [ChangeType.PACK_NEW]: "new pack",
};

const SUGGESTED_ACTION = {
  [ChangeType.REMOTE_ADDED]: "download",
  [ChangeType.REMOTE_MODIFIED]: "download",
  [ChangeType.REMOTE_DELETED]: "delete_local",
  [ChangeType.LOCAL_ADDED]: "upload",
  [ChangeType.LOCAL_MODIFIED]: "upload",
  [ChangeType.LOCAL_DELETED]: "delete_remote",
  [ChangeType.CONFLICT]: "conflict",
  [ChangeType.PACK_LOCAL_MODIFIED]: "push_pack",
  [ChangeType.PACK_REMOTE_MODIFIED]: "pull_pack",
  [ChangeType.PACK_SYNCED]: "none",
  [ChangeType.PACK_CONFLICT]: "resolve_pack",
  [ChangeType.PACK_NEW]: "push_pack",
};

function createChange({
  changeType,
  path,
  fileId = null,
  remoteMeta = null,
  localMeta = null,
  snapshotMeta = null,
}) {
  return {
    changeType,
    path,
    fileId,
    remoteMeta,
    localMeta,
    snapshotMeta,
    shortStatus: SHORT_STATUS[changeType],
    description: DESCRIPTION[changeType],
    suggestedAction: SUGGESTED_ACTION[changeType],
  };
}

function buildDiffResult(changes, packChanges = []) {
  return {
    changes,
    packChanges,
    get remoteChanges() {
      return this.changes.filter((change) =>
        change.changeType.startsWith("remote")
      );
    },
    get localChanges() {
      return this.changes.filter((change) =>
        change.changeType.startsWith("local")
      );
    },
    get conflicts() {
      return this.changes.filter(
        (change) => change.changeType === ChangeType.CONFLICT
      );
    },
    get packConflicts() {
      return this.packChanges.filter(
        (change) => change.changeType === ChangeType.PACK_CONFLICT
      );
    },
    get pendingPackChanges() {
      return this.packChanges.filter(
        (change) =>
          change.changeType === ChangeType.PACK_LOCAL_MODIFIED ||
          change.changeType === ChangeType.PACK_REMOTE_MODIFIED ||
          change.changeType === ChangeType.PACK_NEW
      );
    },
    get syncedPacks() {
      return this.packChanges.filter(
        (change) => change.changeType === ChangeType.PACK_SYNCED
      );
    },
    get isClean() {
      return this.changes.length === 0 && this.pendingPackChanges.length === 0;
    },
    get hasPackChanges() {
      return this.packChanges.length > 0;
    },
  };
}

function remoteChanged(snapshotEntry, remoteEntry) {
  if (isWorkspaceType(remoteEntry.mimeType || "")) {
    return snapshotEntry.modifiedTime !== remoteEntry.modifiedTime;
  }

  return snapshotEntry.md5Checksum !== remoteEntry.md5Checksum;
}

function localChanged(snapshotEntry, localEntry) {
  return snapshotEntry.md5 !== localEntry.md5;
}

function promoteConflicts(changes) {
  const remoteByPath = new Map();
  const localByPath = new Map();

  for (const change of changes) {
    if (change.changeType.startsWith("remote")) {
      remoteByPath.set(change.path, change);
      continue;
    }

    if (change.changeType.startsWith("local")) {
      localByPath.set(change.path, change);
    }
  }

  const conflictPathSet = new Set();
  for (const pathValue of remoteByPath.keys()) {
    if (localByPath.has(pathValue)) {
      conflictPathSet.add(pathValue);
    }
  }

  if (conflictPathSet.size === 0) {
    return changes;
  }

  const filtered = changes.filter(
    (change) => !conflictPathSet.has(change.path)
  );

  for (const pathValue of [...conflictPathSet].sort()) {
    const remoteChange = remoteByPath.get(pathValue);
    const localChange = localByPath.get(pathValue);

    filtered.push(
      createChange({
        changeType: ChangeType.CONFLICT,
        path: pathValue,
        fileId: remoteChange.fileId,
        remoteMeta: remoteChange.remoteMeta,
        localMeta: localChange.localMeta,
        snapshotMeta: remoteChange.snapshotMeta || localChange.snapshotMeta,
      })
    );
  }

  return filtered;
}

/**
 * @param {object|null} snapshot
 * @param {object[]} remoteFiles
 * @param {object} localFiles - Either plain file map or { files, packedDirs }
 * @param {{ root?: string, respectIgnore?: boolean }} options
 */
export function computeDiff(snapshot, remoteFiles, localFiles, { root, respectIgnore = true } = {}) {
  const ignoreRules = root && respectIgnore ? loadIgnoreRules(root) : null;

  // Pre-filter remote files by ignore rules
  if (ignoreRules) {
    remoteFiles = remoteFiles.filter((f) => !ignoreRules.ignores(f.path));
  }
  const changes = [];
  const snapshotFiles = snapshot?.files || {};
  const snapshotLocalFiles = snapshot?.localFiles || {};

  // Handle both old format (plain object) and new format ({ files, packedDirs })
  const localFilesData = localFiles?.files ?? localFiles;

  // Build remote lookup and detect additions/modifications in one pass
  const remoteById = new Map();
  for (const remoteFile of remoteFiles) {
    remoteById.set(remoteFile.id, remoteFile);
    const snapshotEntry = snapshotFiles[remoteFile.id];

    if (!snapshotEntry) {
      changes.push(
        createChange({
          changeType: ChangeType.REMOTE_ADDED,
          path: remoteFile.path,
          fileId: remoteFile.id,
          remoteMeta: remoteFile,
        })
      );
      continue;
    }

    if (remoteChanged(snapshotEntry, remoteFile)) {
      changes.push(
        createChange({
          changeType: ChangeType.REMOTE_MODIFIED,
          path: remoteFile.path,
          fileId: remoteFile.id,
          remoteMeta: remoteFile,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  // Detect remote deletions — snapshot entries missing from remote
  for (const fileId of Object.keys(snapshotFiles)) {
    if (!remoteById.has(fileId)) {
      const snapshotEntry = snapshotFiles[fileId];
      changes.push(
        createChange({
          changeType: ChangeType.REMOTE_DELETED,
          path: snapshotEntry.path || snapshotEntry.localPath || "",
          fileId,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  for (const [relativePath, localMeta] of Object.entries(localFilesData)) {
    const snapshotEntry = snapshotLocalFiles[relativePath];

    if (!snapshotEntry) {
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_ADDED,
          path: relativePath,
          localMeta,
        })
      );
      continue;
    }

    if (localChanged(snapshotEntry, localMeta)) {
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_MODIFIED,
          path: relativePath,
          localMeta,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  for (const [relativePath, snapshotEntry] of Object.entries(snapshotLocalFiles)) {
    if (!(relativePath in localFilesData)) {
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_DELETED,
          path: relativePath,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  // Phase 3: Compute pack changes
  const packChanges = computePackChanges(root, localFiles, snapshot);

  return buildDiffResult(promoteConflicts(changes), packChanges);
}

/**
 * Compute changes for packed directories.
 * @param {string|null} root - Workspace root
 * @param {object} localFilesData - Local files data (may include packedDirs)
 * @param {object|null} snapshot - Previous snapshot
 * @returns {Array} Pack changes
 */
function computePackChanges(root, localFilesData, snapshot) {
  if (!root) return [];

  const packChanges = [];
  const manifest = loadPackManifest(root);
  const localPackedDirs = localFilesData?.packedDirs ?? {};
  const snapshotPackedDirs = snapshot?.packedDirs ?? {};

  // Check each locally detected packed directory
  for (const [packPath, localPack] of Object.entries(localPackedDirs)) {
    const manifestEntry = manifest.packs?.[packPath];
    const snapshotEntry = snapshotPackedDirs[packPath];

    if (!manifestEntry) {
      // New pack - not yet in manifest (never synced)
      packChanges.push(
        createChange({
          changeType: ChangeType.PACK_NEW,
          path: packPath,
          localMeta: localPack,
        })
      );
      continue;
    }

    const localHash = localPack.treeHash;
    const manifestLocalHash = manifestEntry.localTreeHash;
    const manifestRemoteHash = manifestEntry.remoteTreeHash;

    const localChanged = localHash !== manifestLocalHash;
    const remoteChanged = manifestRemoteHash !== manifestLocalHash;

    if (localChanged && remoteChanged) {
      // Both changed - conflict
      packChanges.push(
        createChange({
          changeType: ChangeType.PACK_CONFLICT,
          path: packPath,
          localMeta: { ...localPack, manifestEntry },
          snapshotMeta: snapshotEntry,
        })
      );
    } else if (localChanged) {
      // Only local changed - needs push
      packChanges.push(
        createChange({
          changeType: ChangeType.PACK_LOCAL_MODIFIED,
          path: packPath,
          localMeta: { ...localPack, manifestEntry },
          snapshotMeta: snapshotEntry,
        })
      );
    } else if (remoteChanged) {
      // Only remote changed - needs pull
      packChanges.push(
        createChange({
          changeType: ChangeType.PACK_REMOTE_MODIFIED,
          path: packPath,
          localMeta: { ...localPack, manifestEntry },
          snapshotMeta: snapshotEntry,
        })
      );
    } else {
      // Synced
      packChanges.push(
        createChange({
          changeType: ChangeType.PACK_SYNCED,
          path: packPath,
          localMeta: { ...localPack, manifestEntry },
        })
      );
    }
  }

  return packChanges;
}
