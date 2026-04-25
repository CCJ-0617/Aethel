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
    get hasPackChanges() {
      return this.pendingPackChanges.length > 0 || this.packConflicts.length > 0;
    },
    get isClean() {
      return this.changes.length === 0 && this.pendingPackChanges.length === 0;
    },
  };
}

function remoteChanged(snapshotEntry, remoteEntry) {
  // Folders don't change — only their existence matters
  if (remoteEntry.isFolder || remoteEntry.mimeType === "application/vnd.google-apps.folder") {
    return false;
  }

  if (isWorkspaceType(remoteEntry.mimeType || "")) {
    return snapshotEntry.modifiedTime !== remoteEntry.modifiedTime;
  }

  return snapshotEntry.md5Checksum !== remoteEntry.md5Checksum;
}

function localChanged(snapshotEntry, localEntry) {
  // Folders don't change — only their existence matters
  if (localEntry.isFolder) return false;
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
 * Compute pack-level changes by comparing local packedDirs against manifest.
 * @param {string|null} root - Workspace root for loading manifest
 * @param {object} packedDirs - Local packed directories from scanLocal
 * @param {object|null} snapshot - Previous snapshot (may contain packedDirs)
 * @returns {object[]} Array of pack change objects
 */
function computePackChanges(root, packedDirs, snapshot) {
  if (!root || !packedDirs || Object.keys(packedDirs).length === 0) {
    return [];
  }

  const manifest = loadPackManifest(root);
  const snapshotPackedDirs = snapshot?.packedDirs || {};
  const changes = [];

  for (const [packPath, packInfo] of Object.entries(packedDirs)) {
    const manifestEntry = manifest.packs?.[packPath];
    const snapshotEntry = snapshotPackedDirs[packPath];
    const localTreeHash = packInfo.treeHash;

    if (!manifestEntry) {
      // Pack not in manifest = new pack
      changes.push(
        createChange({
          changeType: ChangeType.PACK_NEW,
          path: packPath,
          localMeta: packInfo,
        })
      );
      continue;
    }

    const { localTreeHash: manifestLocalHash, remoteTreeHash: manifestRemoteHash } = manifestEntry;

    // Check for local modification
    const localChanged = localTreeHash !== manifestLocalHash;
    // Check for remote modification (comparing against what we last synced)
    const remoteChanged = manifestRemoteHash && manifestRemoteHash !== manifestLocalHash;

    if (localChanged && remoteChanged) {
      // Both sides changed = conflict
      changes.push(
        createChange({
          changeType: ChangeType.PACK_CONFLICT,
          path: packPath,
          localMeta: { ...packInfo, treeHash: localTreeHash },
          snapshotMeta: { treeHash: manifestLocalHash },
          remoteMeta: { treeHash: manifestRemoteHash },
        })
      );
    } else if (localChanged) {
      // Only local changed
      changes.push(
        createChange({
          changeType: ChangeType.PACK_LOCAL_MODIFIED,
          path: packPath,
          localMeta: { ...packInfo, treeHash: localTreeHash },
          snapshotMeta: { treeHash: manifestLocalHash },
        })
      );
    } else if (remoteChanged) {
      // Only remote changed
      changes.push(
        createChange({
          changeType: ChangeType.PACK_REMOTE_MODIFIED,
          path: packPath,
          localMeta: packInfo,
          remoteMeta: { treeHash: manifestRemoteHash },
          snapshotMeta: { treeHash: manifestLocalHash },
        })
      );
    } else {
      // No changes = synced
      changes.push(
        createChange({
          changeType: ChangeType.PACK_SYNCED,
          path: packPath,
          localMeta: packInfo,
        })
      );
    }
  }

  return changes;
}

/**
 * @param {object|null} snapshot
 * @param {object[]} remoteFiles
 * @param {object} localFiles
 * @param {{ root?: string, respectIgnore?: boolean }} options
 */
/**
 * Collect all implicit folder paths from a set of file paths.
 * e.g. "a/b/c.txt" → {"a", "a/b"}
 */
function collectFolderPaths(filePaths) {
  const folders = new Set();
  for (const p of filePaths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join("/"));
    }
  }
  return folders;
}

function indexSnapshotFilesByPath(snapshotFiles) {
  const byPath = new Map();

  for (const [fileId, entry] of Object.entries(snapshotFiles || {})) {
    for (const pathValue of [entry.path, entry.localPath]) {
      if (pathValue && !byPath.has(pathValue)) {
        byPath.set(pathValue, { fileId, entry });
      }
    }
  }

  return byPath;
}

export function computeDiff(snapshot, remoteFiles, localFiles, { root, respectIgnore = true } = {}) {
  const ignoreRules = root && respectIgnore ? loadIgnoreRules(root) : null;

  // Pre-filter remote files by ignore rules
  if (ignoreRules) {
    remoteFiles = remoteFiles.filter((f) => !ignoreRules.ignores(f.path));
  }

  // Handle new localFiles format with .files and .packedDirs
  const localFilesData = localFiles?.files ?? localFiles;
  const packedDirs = localFiles?.packedDirs ?? {};

  const changes = [];
  const snapshotFiles = snapshot?.files || {};
  const snapshotLocalFiles = snapshot?.localFiles || {};
  const snapshotRemoteByPath = indexSnapshotFilesByPath(snapshotFiles);

  // Build sets of all folder paths that implicitly exist on each side
  // (from parent directories of files), so we can skip redundant folder additions.
  const remoteFolderPaths = collectFolderPaths(remoteFiles.map((f) => f.path));
  const localFolderPaths = collectFolderPaths(Object.keys(localFilesData));

  // Also include explicit folder entries
  for (const f of remoteFiles) {
    if (f.isFolder) remoteFolderPaths.add(f.path);
  }
  for (const [p, meta] of Object.entries(localFilesData)) {
    if (meta.isFolder) localFolderPaths.add(p);
  }

  // Build remote lookup and detect additions/modifications in one pass
  const remoteById = new Map();
  for (const remoteFile of remoteFiles) {
    remoteById.set(remoteFile.id, remoteFile);
    const snapshotEntry = snapshotFiles[remoteFile.id];

    if (!snapshotEntry) {
      // Skip remote folder if it already exists locally (as parent or explicit dir)
      if (remoteFile.isFolder && localFolderPaths.has(remoteFile.path)) {
        continue;
      }
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
      // Skip folder deletion if the folder still implicitly exists on Drive
      // (e.g. it became non-empty, or was recreated with a different ID)
      if (snapshotEntry.isFolder && remoteFolderPaths.has(snapshotEntry.path || snapshotEntry.localPath || "")) {
        continue;
      }
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
      // Skip local folder if it already exists on Drive (as parent or explicit dir)
      if (localMeta.isFolder && remoteFolderPaths.has(relativePath)) {
        continue;
      }
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
      const remoteEntry = snapshotRemoteByPath.get(relativePath);
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_MODIFIED,
          path: relativePath,
          fileId: remoteEntry?.fileId || null,
          localMeta,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  for (const [relativePath, snapshotEntry] of Object.entries(snapshotLocalFiles)) {
    if (!(relativePath in localFilesData)) {
      // Skip folder deletion if the folder still implicitly exists locally
      if (snapshotEntry.isFolder && localFolderPaths.has(relativePath)) {
        continue;
      }
      const remoteEntry = snapshotRemoteByPath.get(relativePath);
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_DELETED,
          path: relativePath,
          fileId: remoteEntry?.fileId || null,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  // Compute pack changes
  const packChanges = computePackChanges(root, packedDirs, snapshot);

  return buildDiffResult(promoteConflicts(changes), packChanges);
}
