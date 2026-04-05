/**
 * .aethel/ directory management, configuration, and state persistence.
 */

import fs from "node:fs";
import path from "node:path";

export const AETHEL_DIR = ".aethel";
export const CONFIG_FILE = "config.json";
export const INDEX_FILE = "index.json";
export const SNAPSHOTS_DIR = "snapshots";
export const HISTORY_DIR = "history";
export const LATEST_SNAPSHOT = "latest.json";

/** Walk up from `start` looking for a .aethel/ directory. */
export function findRoot(start = process.cwd()) {
  let p = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(p, AETHEL_DIR))) return p;
    const parent = path.dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}

/** Return the workspace root or throw. */
export function requireRoot(start) {
  const root = findRoot(start);
  if (!root) {
    throw new Error(
      "Not an Aethel workspace (no .aethel/ found). Run 'aethel init' first."
    );
  }
  return root;
}

function dot(root) {
  return path.join(root, AETHEL_DIR);
}

/** Create a fresh .aethel/ workspace. Returns the root path. */
export function initWorkspace(localPath, driveFolderId = null, driveFolderName = "My Drive") {
  const root = path.resolve(localPath);
  const d = dot(root);

  if (fs.existsSync(d)) {
    throw new Error(`Workspace already initialised at ${d}`);
  }

  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(d, SNAPSHOTS_DIR));
  fs.mkdirSync(path.join(d, SNAPSHOTS_DIR, HISTORY_DIR));

  const config = {
    version: 1,
    drive_folder_id: driveFolderId,
    drive_folder_name: driveFolderName,
    local_path: root,
  };

  writeConfig(root, config);
  writeIndex(root, { staged: [] });
  return root;
}

// ── config helpers ───────────────────────────────────────────────────

export function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(dot(root), CONFIG_FILE), "utf-8"));
}

export function writeConfig(root, data) {
  fs.writeFileSync(
    path.join(dot(root), CONFIG_FILE),
    JSON.stringify(data, null, 2) + "\n"
  );
}

// ── index (staging area) helpers ─────────────────────────────────────

export function readIndex(root) {
  const p = path.join(dot(root), INDEX_FILE);
  if (!fs.existsSync(p)) return { staged: [] };
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function writeIndex(root, data) {
  fs.writeFileSync(
    path.join(dot(root), INDEX_FILE),
    JSON.stringify(data, null, 2) + "\n"
  );
}

// ── snapshot helpers ─────────────────────────────────────────────────

export function latestSnapshotPath(root) {
  return path.join(dot(root), SNAPSHOTS_DIR, LATEST_SNAPSHOT);
}

export function readLatestSnapshot(root) {
  const p = latestSnapshotPath(root);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function writeSnapshot(root, snapshot) {
  const snapDir = path.join(dot(root), SNAPSHOTS_DIR);
  const latest = path.join(snapDir, LATEST_SNAPSHOT);

  // Archive previous latest
  if (fs.existsSync(latest)) {
    const ts = new Date().toISOString().replace(/[:-]/g, "").replace(/\.\d+Z/, "Z");
    fs.copyFileSync(latest, path.join(snapDir, HISTORY_DIR, `${ts}.json`));
  }

  // Compact JSON — snapshots can be large, pretty-printing is slow + wastes disk
  fs.writeFileSync(latest, JSON.stringify(snapshot) + "\n");
}
