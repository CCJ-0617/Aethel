/**
 * Short-lived cache for remote file listings.
 *
 * Stores the last remote file list in .aethel/.remote-cache.json so that
 * rapid successive commands (e.g. `status` then `add` then `commit`) don't
 * each make a full Drive API round-trip.
 *
 * Default TTL: 60 seconds. Commands that mutate remote state (commit, push)
 * should invalidate the cache.
 */

import fs from "node:fs";
import path from "node:path";
import { AETHEL_DIR } from "./config.js";

const CACHE_FILE = ".remote-cache.json";
const DEFAULT_TTL_MS = 60_000; // 60 seconds

function cachePath(root) {
  return path.join(root, AETHEL_DIR, CACHE_FILE);
}

export function readRemoteCache(root, rootFolderId = null, ttlMs = DEFAULT_TTL_MS) {
  const p = cachePath(root);
  if (!fs.existsSync(p)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const age = Date.now() - (raw.timestamp || 0);
    if (age > ttlMs) return null;
    if ((raw.rootFolderId ?? null) !== (rootFolderId ?? null)) {
      return null;
    }
    if (!Array.isArray(raw.files) || !Array.isArray(raw.duplicateFolders)) {
      return null;
    }
    return {
      files: raw.files,
      duplicateFolders: raw.duplicateFolders,
    };
  } catch {
    return null;
  }
}

export function writeRemoteCache(root, remoteState, rootFolderId = null) {
  const p = cachePath(root);
  fs.writeFileSync(
    p,
    JSON.stringify({
      timestamp: Date.now(),
      rootFolderId: rootFolderId ?? null,
      count: remoteState.files.length,
      files: remoteState.files,
      duplicateFolders: remoteState.duplicateFolders,
    }) + "\n"
  );
}

export function invalidateRemoteCache(root) {
  const p = cachePath(root);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}
