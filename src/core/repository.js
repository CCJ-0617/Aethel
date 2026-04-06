/**
 * Repository — unified data-access layer for Aethel workspaces.
 *
 * Wraps all core modules behind a single interface so that both
 * the CLI and the TUI share the same entry point for state loading,
 * staging, syncing, file browsing, and history.
 */

import fs from "node:fs";
import path from "node:path";
import { authenticate } from "./auth.js";
import {
  AETHEL_DIR,
  HISTORY_DIR,
  LATEST_SNAPSHOT,
  SNAPSHOTS_DIR,
  readConfig,
  readLatestSnapshot,
  writeConfig,
  writeSnapshot,
} from "./config.js";
import { computeDiff } from "./diff.js";
import {
  assertNoDuplicateFolders,
  batchOperateFiles,
  getAccountInfo,
  getRemoteState,
  listAccessibleFiles,
  listRootFolders,
  syncLocalDirectoryToParent,
  uploadLocalEntry,
  withDriveRetry,
} from "./drive-api.js";
import {
  invalidateRemoteCache,
  readRemoteCache,
  writeRemoteCache,
} from "./remote-cache.js";
import {
  buildSnapshot,
  hashFile,
  md5Local,
  scanLocal,
  verifySnapshotChecksum,
} from "./snapshot.js";
import {
  stageChange,
  stageChanges,
  stageConflictResolution,
  stagedEntries,
  unstageAll,
  unstagePath,
} from "./staging.js";
import { executeStaged } from "./sync.js";
import {
  deleteLocalEntry,
  listLocalEntries,
  renameLocalEntry,
} from "./local-fs.js";

export class Repository {
  /**
   * @param {string|null} root  Workspace root (null for workspace-less commands like auth/clean)
   * @param {object} [options]
   * @param {object} [options.drive]       Pre-authenticated drive instance (skips auth)
   * @param {string} [options.credentials] Path to OAuth credentials JSON
   * @param {string} [options.token]       Path to OAuth token JSON
   */
  constructor(root, options = {}) {
    this._root = root;
    this._options = options;
    this._drive = options.drive || null;
    this._config = null;
  }

  get root() {
    return this._root;
  }

  get isConnected() {
    return this._drive !== null;
  }

  get drive() {
    if (!this._drive) {
      throw new Error("Repository is not connected. Call connect() first.");
    }
    return this._drive;
  }

  /** Authenticate and prepare the drive connection. Idempotent. */
  async connect() {
    if (this._drive) return;
    const raw = await authenticate(this._options.credentials, this._options.token);
    this._drive = withDriveRetry(raw);
  }

  // ── Config ──────────────────────────────────────────────────────────

  getConfig() {
    if (!this._config) {
      this._config = readConfig(this._root);
    }
    return this._config;
  }

  setConfig(data) {
    writeConfig(this._root, data);
    this._config = null;
  }

  // ── State loading (sync workflow) ───────────────────────────────────

  /**
   * Load full workspace state in parallel, replacing the old
   * loadWorkspaceState() helper from cli.js.
   */
  async loadState({ useCache = true, onPhase } = {}) {
    const config = this.getConfig();
    const t0 = Date.now();

    // Run all three in parallel — remote fetch is the slowest, overlap it
    // with local scan and snapshot read.
    const timings = {};

    const [local, snapshot, remoteState] = await Promise.all([
      scanLocal(this._root).then((r) => {
        timings.localMs = Date.now() - t0;
        onPhase?.("local", timings.localMs);
        return r;
      }),
      Promise.resolve(readLatestSnapshot(this._root)).then((r) => {
        timings.snapshotMs = Date.now() - t0;
        return r;
      }),
      this._loadRemoteState({ useCache }).then((r) => {
        timings.remoteMs = Date.now() - t0;
        timings.remoteCached = useCache && timings.remoteMs < 100;
        onPhase?.("remote", timings.remoteMs);
        return r;
      }),
    ]);
    const remote = remoteState.files;

    const diffStart = Date.now();
    const diff = computeDiff(snapshot, remote, local, { root: this._root });
    timings.diffMs = Date.now() - diffStart;
    timings.totalMs = Date.now() - t0;
    timings.localFiles = Object.keys(local).length;
    timings.remoteFiles = remote.length;

    return {
      config,
      remote,
      remoteState,
      local,
      snapshot,
      diff,
      timings,
    };
  }

  async getRemoteState({ useCache = true } = {}) {
    return this._loadRemoteState({ useCache });
  }

  async scanLocal() {
    return scanLocal(this._root);
  }

  getSnapshot() {
    return readLatestSnapshot(this._root);
  }

  computeDiff(snapshot, remote, local) {
    return computeDiff(snapshot, remote, local, { root: this._root });
  }

  // ── Staging ─────────────────────────────────────────────────────────

  getStagedEntries() {
    return stagedEntries(this._root);
  }

  stageChange(change) {
    return stageChange(this._root, change);
  }

  stageChanges(changes) {
    return stageChanges(this._root, changes);
  }

  unstagePath(targetPath) {
    return unstagePath(this._root, targetPath);
  }

  unstageAll() {
    return unstageAll(this._root);
  }

  stageConflictResolution(change, strategy) {
    return stageConflictResolution(this._root, change, strategy);
  }

  // ── Sync execution ──────────────────────────────────────────────────

  async executeStaged(progress) {
    return executeStaged(this.drive, this._root, progress);
  }

  /**
   * Build and persist a new snapshot.
   *
   * @param {string} message
   * @param {object} [preloaded]
   * @param {object} [preloaded.remote]  Reuse this remote state (skip API call)
   * @param {object} [preloaded.local]   Reuse this local scan  (skip fs walk)
   */
  async saveSnapshot(message = "sync", { remote, local } = {}) {
    const config = this.getConfig();
    const rootFolderId = config.drive_folder_id || null;

    // Only fetch what wasn't pre-loaded, in parallel.
    const needRemote = !remote;
    const needLocal = !local;

    if (needRemote) invalidateRemoteCache(this._root);

    const [remoteState, localFiles] = await Promise.all([
      needRemote ? getRemoteState(this.drive, rootFolderId) : remote,
      needLocal ? scanLocal(this._root) : local,
    ]);

    assertNoDuplicateFolders(remoteState.duplicateFolders);
    writeRemoteCache(this._root, remoteState, rootFolderId);
    writeSnapshot(this._root, buildSnapshot(remoteState.files, localFiles, message));
  }

  // ── Cache management ────────────────────────────────────────────────

  invalidateRemoteCache() {
    invalidateRemoteCache(this._root);
  }

  // ── File browser (TUI) ─────────────────────────────────────────────

  async listRootFolders() {
    return listRootFolders(this.drive);
  }

  async listRemoteFiles({ includeSharedDrives = false } = {}) {
    return listAccessibleFiles(this.drive, includeSharedDrives);
  }

  async listLocalEntries(targetPath) {
    return listLocalEntries(targetPath);
  }

  async deleteLocalEntry(targetPath) {
    return deleteLocalEntry(targetPath);
  }

  async renameLocalEntry(targetPath, newName) {
    return renameLocalEntry(targetPath, newName);
  }

  async uploadLocalEntry(localPath, parentId, onProgress) {
    return uploadLocalEntry(this.drive, localPath, parentId, onProgress);
  }

  async syncLocalDirectory(localPath, parentId, onProgress) {
    return syncLocalDirectoryToParent(this.drive, localPath, parentId, onProgress);
  }

  async batchOperateFiles(files, options) {
    return batchOperateFiles(this.drive, files, options);
  }

  async getAccountInfo() {
    return getAccountInfo(this.drive);
  }

  // ── History ─────────────────────────────────────────────────────────

  getHistory(limit = 10) {
    const snapshotsPath = path.join(this._root, AETHEL_DIR, SNAPSHOTS_DIR);
    const entries = [];

    const latestPath = path.join(snapshotsPath, LATEST_SNAPSHOT);
    if (fs.existsSync(latestPath)) {
      entries.push(JSON.parse(fs.readFileSync(latestPath, "utf8")));
    }

    const historyPath = path.join(snapshotsPath, HISTORY_DIR);
    if (fs.existsSync(historyPath)) {
      const historyFiles = fs
        .readdirSync(historyPath)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse();

      for (const fileName of historyFiles) {
        entries.push(
          JSON.parse(fs.readFileSync(path.join(historyPath, fileName), "utf8"))
        );
      }
    }

    return entries.slice(0, limit);
  }

  getSnapshotByRef(ref) {
    if (!ref || ref === "HEAD" || ref === "latest") {
      return readLatestSnapshot(this._root);
    }

    const historyPath = path.join(
      this._root,
      AETHEL_DIR,
      SNAPSHOTS_DIR,
      HISTORY_DIR
    );

    if (!fs.existsSync(historyPath)) return null;

    const files = fs
      .readdirSync(historyPath)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();

    const match = files.find((f) => f.startsWith(ref));
    if (!match) return null;

    return JSON.parse(fs.readFileSync(path.join(historyPath, match), "utf-8"));
  }

  // ── Integrity verification ──────────────────────────────────────────

  /**
   * Full integrity verification of the workspace.
   * Checks: snapshot checksum, local files vs snapshot md5, remote vs snapshot md5.
   *
   * @param {object} [options]
   * @param {boolean} [options.checkRemote=false]  Also verify remote checksums (requires connect)
   * @param {function} [options.onProgress]         (done, total, path, status) callback
   * @returns {{ ok: boolean, snapshot: object, local: object[], remote: object[] }}
   */
  async verify({ checkRemote = false, onProgress } = {}) {
    const snapshot = readLatestSnapshot(this._root, { verify: true });
    const result = { ok: true, snapshot: { valid: true }, local: [], remote: [] };

    if (!snapshot) {
      return { ok: true, snapshot: { valid: true, reason: "no snapshot yet" }, local: [], remote: [] };
    }

    // 1. Snapshot integrity
    const snapshotCheck = verifySnapshotChecksum(snapshot);
    result.snapshot = snapshotCheck;
    if (!snapshotCheck.valid) result.ok = false;

    // 2. Local file integrity vs snapshot
    const localFiles = snapshot.localFiles || {};
    const entries = Object.entries(localFiles).filter(([, meta]) => !meta.isFolder);
    const total = entries.length + (checkRemote ? Object.keys(snapshot.files || {}).length : 0);
    let done = 0;

    for (const [relativePath, meta] of entries) {
      const absPath = path.join(this._root, ...relativePath.split("/"));
      const entry = { path: relativePath, status: "ok" };

      if (!fs.existsSync(absPath)) {
        entry.status = "missing";
        result.ok = false;
      } else if (meta.md5) {
        const actual = await md5Local(absPath);
        if (actual !== meta.md5) {
          entry.status = "modified";
          entry.expected = meta.md5;
          entry.actual = actual;
          result.ok = false;
        }
      }

      if (entry.status !== "ok") result.local.push(entry);
      done++;
      onProgress?.(done, total, relativePath, entry.status);
    }

    // 3. Remote integrity vs snapshot (optional, requires API call)
    if (checkRemote) {
      const remoteState = await this._loadRemoteState({ useCache: false });
      const remoteById = new Map(remoteState.files.map((f) => [f.id, f]));

      for (const [fileId, snapEntry] of Object.entries(snapshot.files || {})) {
        if (snapEntry.isFolder) { done++; continue; }
        const entry = { path: snapEntry.path || snapEntry.localPath, status: "ok" };
        const remote = remoteById.get(fileId);

        if (!remote) {
          entry.status = "deleted_remote";
          result.ok = false;
        } else if (snapEntry.md5Checksum && remote.md5Checksum && snapEntry.md5Checksum !== remote.md5Checksum) {
          entry.status = "modified_remote";
          entry.expected = snapEntry.md5Checksum;
          entry.actual = remote.md5Checksum;
          result.ok = false;
        }

        if (entry.status !== "ok") result.remote.push(entry);
        done++;
        onProgress?.(done, total, entry.path, entry.status);
      }
    }

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  async _loadRemoteState({ useCache = true } = {}) {
    const config = this.getConfig();
    const rootFolderId = config.drive_folder_id || null;

    let remoteState = useCache
      ? readRemoteCache(this._root, rootFolderId)
      : null;

    if (!remoteState) {
      remoteState = await getRemoteState(this.drive, rootFolderId);
      writeRemoteCache(this._root, remoteState, rootFolderId);
    }

    assertNoDuplicateFolders(remoteState.duplicateFolders);
    return remoteState;
  }
}
