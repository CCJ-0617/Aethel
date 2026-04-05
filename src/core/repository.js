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
  syncLocalDirectoryToParent,
  uploadLocalEntry,
  withDriveRetry,
} from "./drive-api.js";
import {
  invalidateRemoteCache,
  readRemoteCache,
  writeRemoteCache,
} from "./remote-cache.js";
import { buildSnapshot, scanLocal } from "./snapshot.js";
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
  async loadState({ useCache = true } = {}) {
    const config = this.getConfig();

    const [local, snapshot] = await Promise.all([
      scanLocal(this._root),
      Promise.resolve(readLatestSnapshot(this._root)),
    ]);

    const remoteState = await this._loadRemoteState({ useCache });
    const remote = remoteState.files;

    return {
      config,
      remote,
      local,
      snapshot,
      diff: computeDiff(snapshot, remote, local, { root: this._root }),
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
   * Invalidate cache, re-fetch remote + re-scan local, write snapshot.
   */
  async saveSnapshot(message = "sync") {
    const config = this.getConfig();
    const rootFolderId = config.drive_folder_id || null;

    invalidateRemoteCache(this._root);
    const [remoteState, local] = await Promise.all([
      getRemoteState(this.drive, rootFolderId),
      scanLocal(this._root),
    ]);
    assertNoDuplicateFolders(remoteState.duplicateFolders);
    writeRemoteCache(this._root, remoteState, rootFolderId);
    writeSnapshot(this._root, buildSnapshot(remoteState.files, local, message));
  }

  // ── Cache management ────────────────────────────────────────────────

  invalidateRemoteCache() {
    invalidateRemoteCache(this._root);
  }

  // ── File browser (TUI) ─────────────────────────────────────────────

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
