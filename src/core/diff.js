import { isWorkspaceType } from "./drive-api.js";
import { loadIgnoreRules } from "./ignore.js";

export const ChangeType = Object.freeze({
  REMOTE_ADDED: "remote_added",
  REMOTE_MODIFIED: "remote_modified",
  REMOTE_DELETED: "remote_deleted",
  LOCAL_ADDED: "local_added",
  LOCAL_MODIFIED: "local_modified",
  LOCAL_DELETED: "local_deleted",
  CONFLICT: "conflict",
});

const SHORT_STATUS = {
  [ChangeType.REMOTE_ADDED]: "+R",
  [ChangeType.REMOTE_MODIFIED]: "MR",
  [ChangeType.REMOTE_DELETED]: "-R",
  [ChangeType.LOCAL_ADDED]: "+L",
  [ChangeType.LOCAL_MODIFIED]: "ML",
  [ChangeType.LOCAL_DELETED]: "-L",
  [ChangeType.CONFLICT]: "!!",
};

const DESCRIPTION = {
  [ChangeType.REMOTE_ADDED]: "new on Drive",
  [ChangeType.REMOTE_MODIFIED]: "modified on Drive",
  [ChangeType.REMOTE_DELETED]: "deleted on Drive",
  [ChangeType.LOCAL_ADDED]: "new locally",
  [ChangeType.LOCAL_MODIFIED]: "modified locally",
  [ChangeType.LOCAL_DELETED]: "deleted locally",
  [ChangeType.CONFLICT]: "both sides changed",
};

const SUGGESTED_ACTION = {
  [ChangeType.REMOTE_ADDED]: "download",
  [ChangeType.REMOTE_MODIFIED]: "download",
  [ChangeType.REMOTE_DELETED]: "delete_local",
  [ChangeType.LOCAL_ADDED]: "upload",
  [ChangeType.LOCAL_MODIFIED]: "upload",
  [ChangeType.LOCAL_DELETED]: "delete_remote",
  [ChangeType.CONFLICT]: "conflict",
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

function buildDiffResult(changes) {
  return {
    changes,
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
    get isClean() {
      return this.changes.length === 0;
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
 * @param {object} localFiles
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
  const snapshotById = new Map();

  for (const [fileId, meta] of Object.entries(snapshotFiles)) {
    snapshotById.set(fileId, meta);
  }

  const remoteById = new Map(remoteFiles.map((file) => [file.id, file]));

  for (const remoteFile of remoteFiles) {
    const snapshotEntry = snapshotById.get(remoteFile.id);

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

  for (const [fileId, snapshotEntry] of snapshotById.entries()) {
    if (!remoteById.has(fileId)) {
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

  for (const [relativePath, localMeta] of Object.entries(localFiles)) {
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
    if (!(relativePath in localFiles)) {
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_DELETED,
          path: relativePath,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  return buildDiffResult(promoteConflicts(changes));
}
