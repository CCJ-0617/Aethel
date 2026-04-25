import fs from "node:fs";
import path from "node:path";
import { readConfig, readIndex, readLatestSnapshot, writeIndex } from "./config.js";
import { downloadFile, ensureFolder, trashFile, uploadFile } from "./drive-api.js";
import { md5Local } from "./snapshot.js";

function readPositiveIntEnv(name, fallback) {
  const rawValue = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : fallback;
}

const CONCURRENCY = readPositiveIntEnv("AETHEL_DRIVE_CONCURRENCY", 10);

function toLocalAbsolutePath(root, relativePath) {
  const abs = path.resolve(root, ...relativePath.split("/"));
  const resolvedRoot = path.resolve(root);
  if (!abs.startsWith(resolvedRoot + path.sep) && abs !== resolvedRoot) {
    throw new Error(`Path traversal blocked: ${relativePath} resolves outside workspace`);
  }
  return abs;
}

export class CommitResult {
  constructor() {
    this.downloaded = 0;
    this.uploaded = 0;
    this.deletedLocal = 0;
    this.deletedRemote = 0;
    this.foldersCreated = 0;
    this.errors = [];
  }

  get total() {
    return (
      this.downloaded +
      this.uploaded +
      this.deletedLocal +
      this.deletedRemote +
      this.foldersCreated
    );
  }

  get summary() {
    const parts = [];

    if (this.downloaded) {
      parts.push(`${this.downloaded} downloaded`);
    }
    if (this.uploaded) {
      parts.push(`${this.uploaded} uploaded`);
    }
    if (this.foldersCreated) {
      parts.push(`${this.foldersCreated} folders created`);
    }
    if (this.deletedLocal) {
      parts.push(`${this.deletedLocal} deleted locally`);
    }
    if (this.deletedRemote) {
      parts.push(`${this.deletedRemote} deleted on Drive`);
    }
    if (this.errors.length) {
      parts.push(`${this.errors.length} errors`);
    }

    return parts.length ? parts.join(", ") : "nothing to do";
  }
}

async function downloadStagedFile(drive, entry, root) {
  const localRelativePath = entry.localPath || entry.path;
  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);

  // Empty folder: just create the directory locally
  if (entry.isFolder) {
    fs.mkdirSync(localAbsolutePath, { recursive: true });
    return;
  }

  const fileId = entry.fileId;
  const response = await drive.files.get({
    fileId,
    fields: "id,name,mimeType",
  });

  await downloadFile(drive, { ...response.data, id: fileId }, localAbsolutePath);
}

async function uploadStagedFile(drive, entry, root, driveFolderId) {
  const localRelativePath = entry.localPath || entry.path;
  const remotePath = entry.remotePath || entry.path;

  // Empty folder: just ensure it exists on Drive
  if (entry.isFolder) {
    await ensureFolder(drive, remotePath, driveFolderId);
    return;
  }

  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);

  if (!fs.existsSync(localAbsolutePath)) {
    throw new Error(`Local file not found: ${localAbsolutePath}`);
  }

  const parentPath = path.posix.dirname(remotePath);
  let parentId = driveFolderId || "root";

  if (parentPath && parentPath !== ".") {
    parentId = await ensureFolder(drive, parentPath, driveFolderId);
  }

  const uploadResult = await uploadFile(drive, localAbsolutePath, remotePath, {
    parentId,
    existingId: entry.fileId || null,
  });

  // Verify: Drive-returned md5 must match the local file we just uploaded.
  // Google Workspace files (Docs, Sheets, etc.) don't have md5 — skip them.
  if (uploadResult?.md5Checksum) {
    const localMd5 = await md5Local(localAbsolutePath);
    if (localMd5 !== uploadResult.md5Checksum) {
      throw new Error(
        `Upload integrity check failed for ${remotePath}: ` +
        `local md5 ${localMd5}, Drive returned ${uploadResult.md5Checksum}`
      );
    }
  }
}

async function deleteLocalFile(entry, root) {
  const localRelativePath = entry.localPath || entry.path;
  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);

  if (!fs.existsSync(localAbsolutePath)) {
    return;
  }

  // Empty folder: remove the directory itself
  if (entry.isFolder) {
    await fs.promises.rmdir(localAbsolutePath).catch(() => {});
  } else {
    await fs.promises.unlink(localAbsolutePath);
  }

  // Clean up empty parent directories up to workspace root
  let currentPath = entry.isFolder ? localAbsolutePath : path.dirname(localAbsolutePath);
  const resolvedRoot = path.resolve(root);

  while (currentPath !== resolvedRoot) {
    try {
      const contents = await fs.promises.readdir(currentPath);
      if (contents.length > 0) break;
      await fs.promises.rmdir(currentPath);
    } catch {
      break;
    }
    currentPath = path.dirname(currentPath);
  }
}

function findSnapshotFileIdByPath(snapshot, entry) {
  const targetPaths = new Set(
    [entry.remotePath, entry.path, entry.localPath].filter(Boolean)
  );

  for (const [fileId, snapshotEntry] of Object.entries(snapshot?.files || {})) {
    if (
      targetPaths.has(snapshotEntry.path) ||
      targetPaths.has(snapshotEntry.localPath)
    ) {
      return fileId;
    }
  }

  return null;
}

async function deleteRemoteFile(drive, entry, snapshot) {
  const fileId = entry.fileId || findSnapshotFileIdByPath(snapshot, entry);

  if (!fileId) {
    throw new Error("No fileId was found for delete_remote.");
  }

  await trashFile(drive, fileId);
}

// ── Bounded-concurrency runner ───────────────────────────────────────

async function runConcurrent(tasks, limit, onDone) {
  let next = 0;
  let running = 0;
  let done = 0;

  return new Promise((resolve, reject) => {
    function launch() {
      while (running < limit && next < tasks.length) {
        const index = next++;
        running++;
        tasks[index]()
          .then((result) => {
            running--;
            done++;
            onDone?.(done, tasks.length, index, null, result);
            if (done === tasks.length) resolve();
            else launch();
          })
          .catch((err) => {
            running--;
            done++;
            onDone?.(done, tasks.length, index, err, null);
            if (done === tasks.length) resolve();
            else launch();
          });
      }
    }
    if (tasks.length === 0) resolve();
    else launch();
  });
}

// ── Main executor ────────────────────────────────────────────────────

export async function executeStaged(drive, root, progress) {
  const config = readConfig(root);
  const index = readIndex(root);
  const staged = index.staged || [];
  const snapshot = readLatestSnapshot(root);
  const driveFolderId = config.drive_folder_id || null;
  const result = new CommitResult();

  // Local deletes can run fully in parallel — no API rate limits.
  // Remote operations (download, upload, delete_remote) share a concurrency pool.
  const localDeletes = [];
  const remoteOps = [];
  const failedPaths = new Set();

  for (const [i, entry] of staged.entries()) {
    if (entry.action === "delete_local") {
      localDeletes.push({ index: i, entry });
    } else {
      remoteOps.push({ index: i, entry });
    }
  }

  // Run local deletes first (fast, no API)
  await Promise.all(
    localDeletes.map(async ({ entry }) => {
      try {
        await deleteLocalFile(entry, root);
        result.deletedLocal++;
      } catch (err) {
        failedPaths.add(entry.path);
        result.errors.push(`delete_local ${entry.path}: ${err.message}`);
      }
    })
  );

  // Run remote operations with bounded concurrency
  const tasks = remoteOps.map(({ entry }) => {
    return async () => {
      const action = entry.action;
      if (action === "download") {
        await downloadStagedFile(drive, entry, root);
        if (entry.isFolder) result.foldersCreated++;
        else result.downloaded++;
      } else if (action === "upload") {
        await uploadStagedFile(drive, entry, root, driveFolderId);
        if (entry.isFolder) result.foldersCreated++;
        else result.uploaded++;
      } else if (action === "delete_remote") {
        await deleteRemoteFile(drive, entry, snapshot);
        result.deletedRemote++;
      } else {
        throw new Error(`Unknown action '${action}'`);
      }
      return entry;
    };
  });

  let completed = localDeletes.length;
  await runConcurrent(tasks, CONCURRENCY, (done, total, idx, err, entry) => {
    completed++;
    const op = remoteOps[idx];
    if (err) {
      failedPaths.add(op.entry.path);
      result.errors.push(`${op.entry.action} ${op.entry.path}: ${err.message}`);
    }
    progress?.(completed - 1, staged.length, op.entry.action, path.posix.basename(op.entry.path || ""));
  });

  progress?.(staged.length, staged.length, "done", "");

  // Only clear succeeded entries — keep failed ones staged for retry
  if (failedPaths.size > 0) {
    index.staged = staged.filter((e) => failedPaths.has(e.path));
  } else {
    index.staged = [];
  }
  writeIndex(root, index);

  return result;
}
