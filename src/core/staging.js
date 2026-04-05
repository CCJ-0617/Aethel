import { readIndex, writeIndex } from "./config.js";

export function stagedEntries(root) {
  return readIndex(root).staged || [];
}

function changeToEntry(change) {
  const entry = {
    action: change.suggestedAction,
    path: change.path,
    localPath: change.localMeta?.localPath || change.path,
  };

  if (change.fileId) {
    entry.fileId = change.fileId;
  }

  if (change.remoteMeta?.path) {
    entry.remotePath = change.remoteMeta.path;
  }

  // Propagate folder flag so sync knows to create folder instead of uploading file
  if (change.localMeta?.isFolder || change.remoteMeta?.isFolder) {
    entry.isFolder = true;
  }

  return entry;
}

export function stageChange(root, change) {
  const index = readIndex(root);
  const staged = (index.staged || []).filter(
    (entry) => entry.path !== change.path
  );
  staged.push(changeToEntry(change));
  index.staged = staged;
  writeIndex(root, index);
}

export function stageChanges(root, changes) {
  const index = readIndex(root);
  const byPath = new Map((index.staged || []).map((entry) => [entry.path, entry]));

  for (const change of changes) {
    byPath.set(change.path, changeToEntry(change));
  }

  index.staged = [...byPath.values()];
  writeIndex(root, index);
  return changes.length;
}

export function unstagePath(root, targetPath) {
  const index = readIndex(root);
  const staged = index.staged || [];
  const next = staged.filter((entry) => entry.path !== targetPath);

  if (next.length === staged.length) {
    return false;
  }

  index.staged = next;
  writeIndex(root, index);
  return true;
}

export function unstageAll(root) {
  const index = readIndex(root);
  const count = (index.staged || []).length;
  index.staged = [];
  writeIndex(root, index);
  return count;
}

/**
 * Stage a conflict with an explicit resolution strategy.
 * @param {"ours"|"theirs"|"both"} strategy
 */
export function stageConflictResolution(root, change, strategy) {
  if (strategy === "theirs") {
    // Keep remote version → download
    return stageChange(root, {
      ...change,
      changeType: "remote_modified",
      suggestedAction: "download",
    });
  }

  if (strategy === "ours") {
    // Keep local version → upload
    return stageChange(root, {
      ...change,
      changeType: "local_modified",
      suggestedAction: "upload",
    });
  }

  if (strategy === "both") {
    // Keep both: download remote as .remote copy, keep local as-is, then upload local
    const index = readIndex(root);
    const staged = (index.staged || []).filter(
      (entry) => entry.path !== change.path
    );

    // Stage download of remote with a renamed path
    const ext = change.path.includes(".") ? "." + change.path.split(".").pop() : "";
    const base = ext ? change.path.slice(0, -ext.length) : change.path;
    const remoteCopyPath = `${base}.remote${ext}`;

    staged.push({
      action: "download",
      path: remoteCopyPath,
      localPath: remoteCopyPath,
      fileId: change.fileId,
      remotePath: change.remoteMeta?.path || change.path,
    });

    // Stage upload of local version
    staged.push({
      action: "upload",
      path: change.path,
      localPath: change.localMeta?.localPath || change.path,
      fileId: change.fileId,
      remotePath: change.remoteMeta?.path || change.path,
    });

    index.staged = staged;
    writeIndex(root, index);
  }
}
