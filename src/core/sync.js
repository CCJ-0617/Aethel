import fs from "node:fs";
import path from "node:path";
import { readConfig, readIndex, writeIndex } from "./config.js";
import { downloadFile, ensureFolder, trashFile, uploadFile } from "./drive-api.js";

function readPositiveIntEnv(name, fallback) {
  const rawValue = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : fallback;
}

const CONCURRENCY = readPositiveIntEnv("AETHEL_DRIVE_CONCURRENCY", 10);

function toLocalAbsolutePath(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

export class CommitResult {
  constructor() {
    this.downloaded = 0;
    this.uploaded = 0;
    this.deletedLocal = 0;
    this.deletedRemote = 0;
    this.errors = [];
  }

  get total() {
    return (
      this.downloaded +
      this.uploaded +
      this.deletedLocal +
      this.deletedRemote
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
  const fileId = entry.fileId;
  const localRelativePath = entry.localPath || entry.path;
  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);
  const response = await drive.files.get({
    fileId,
    fields: "id,name,mimeType",
  });

  await downloadFile(drive, { ...response.data, id: fileId }, localAbsolutePath);
}

async function uploadStagedFile(drive, entry, root, driveFolderId) {
  const localRelativePath = entry.localPath || entry.path;
  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);
  const remotePath = entry.remotePath || entry.path;

  if (!fs.existsSync(localAbsolutePath)) {
    throw new Error(`Local file not found: ${localAbsolutePath}`);
  }

  const parentPath = path.posix.dirname(remotePath);
  let parentId = driveFolderId || "root";

  if (parentPath && parentPath !== ".") {
    parentId = await ensureFolder(drive, parentPath, driveFolderId);
  }

  await uploadFile(drive, localAbsolutePath, remotePath, {
    parentId,
    existingId: entry.fileId || null,
  });
}

async function deleteLocalFile(entry, root) {
  const localRelativePath = entry.localPath || entry.path;
  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);

  if (!fs.existsSync(localAbsolutePath)) {
    return;
  }

  await fs.promises.unlink(localAbsolutePath);

  let currentPath = path.dirname(localAbsolutePath);
  const resolvedRoot = path.resolve(root);

  while (currentPath !== resolvedRoot) {
    const contents = await fs.promises.readdir(currentPath);
    if (contents.length > 0) {
      break;
    }

    await fs.promises.rmdir(currentPath);
    currentPath = path.dirname(currentPath);
  }
}

async function deleteRemoteFile(drive, entry) {
  if (!entry.fileId) {
    throw new Error("No fileId was found for delete_remote.");
  }

  await trashFile(drive, entry.fileId);
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
  const driveFolderId = config.drive_folder_id || null;
  const result = new CommitResult();

  // Local deletes can run fully in parallel — no API rate limits.
  // Remote operations (download, upload, delete_remote) share a concurrency pool.
  const localDeletes = [];
  const remoteOps = [];

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
        result.downloaded++;
      } else if (action === "upload") {
        await uploadStagedFile(drive, entry, root, driveFolderId);
        result.uploaded++;
      } else if (action === "delete_remote") {
        await deleteRemoteFile(drive, entry);
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
      result.errors.push(`${op.entry.action} ${op.entry.path}: ${err.message}`);
    }
    progress?.(completed - 1, staged.length, op.entry.action, path.posix.basename(op.entry.path || ""));
  });

  progress?.(staged.length, staged.length, "done", "");
  index.staged = [];
  writeIndex(root, index);

  return result;
}
