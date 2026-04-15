/**
 * Pack manifest CRUD operations.
 * Manages the pack-manifest.json data structure.
 */

import crypto from "node:crypto";

const MANIFEST_VERSION = 1;

/**
 * Create a new empty manifest.
 * @returns {{ version: number, packs: {} }}
 */
export function createManifest() {
  return {
    version: MANIFEST_VERSION,
    packs: {},
  };
}

/**
 * Get pack information for a specific path.
 * @param {object} manifest - Manifest object
 * @param {string} packPath - Directory path (e.g., "node_modules")
 * @returns {object|null} Pack info or null if not found
 */
export function getPack(manifest, packPath) {
  const normalized = normalizePath(packPath);
  return manifest.packs[normalized] ?? null;
}

/**
 * Set or update pack information.
 * @param {object} manifest - Manifest object
 * @param {string} packPath - Directory path
 * @param {object} data - Pack data to set/merge
 * @returns {object} Updated manifest
 */
export function setPack(manifest, packPath, data) {
  const normalized = normalizePath(packPath);
  const existing = manifest.packs[normalized] ?? {};

  manifest.packs[normalized] = {
    ...existing,
    ...data,
    // Always update lastModified when setting
    lastModified: new Date().toISOString(),
  };

  return manifest;
}

/**
 * Remove a pack from the manifest.
 * @param {object} manifest - Manifest object
 * @param {string} packPath - Directory path
 * @returns {object} Updated manifest
 */
export function removePack(manifest, packPath) {
  const normalized = normalizePath(packPath);
  delete manifest.packs[normalized];
  return manifest;
}

/**
 * List all packs in the manifest.
 * @param {object} manifest - Manifest object
 * @returns {Array<{ path: string, info: object }>}
 */
export function listPacks(manifest) {
  return Object.entries(manifest.packs).map(([path, info]) => ({
    path,
    info,
  }));
}

/**
 * Check if a path is covered by any pack rule.
 * @param {object} manifest - Manifest object
 * @param {string} filePath - File path to check
 * @returns {{ isPacked: boolean, packPath: string|null }}
 */
export function isPathPacked(manifest, filePath) {
  const normalized = normalizePath(filePath);

  for (const packPath of Object.keys(manifest.packs)) {
    // Check if filePath starts with packPath
    if (normalized === packPath || normalized.startsWith(packPath + "/")) {
      return { isPacked: true, packPath };
    }
  }

  return { isPacked: false, packPath: null };
}

/**
 * Validate manifest structure.
 * @param {object} manifest - Manifest to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== "object") {
    errors.push("Manifest must be an object");
    return { valid: false, errors };
  }

  if (typeof manifest.version !== "number") {
    errors.push("Manifest version must be a number");
  }

  if (manifest.version !== MANIFEST_VERSION) {
    errors.push(`Unsupported manifest version: ${manifest.version} (expected ${MANIFEST_VERSION})`);
  }

  if (!manifest.packs || typeof manifest.packs !== "object") {
    errors.push("Manifest packs must be an object");
  } else {
    for (const [path, info] of Object.entries(manifest.packs)) {
      if (typeof path !== "string" || path.length === 0) {
        errors.push(`Invalid pack path: ${path}`);
      }
      if (!info || typeof info !== "object") {
        errors.push(`Pack info for "${path}" must be an object`);
      } else {
        if (!info.packId || typeof info.packId !== "string") {
          errors.push(`Pack "${path}" missing valid packId`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Generate a unique pack ID.
 * @param {string} packPath - Directory path
 * @returns {string} Pack ID like "pack-node_modules-a1b2c3d4"
 */
export function generatePackId(packPath) {
  const normalized = normalizePath(packPath);
  // Sanitize path for ID: replace / with _ and remove special chars
  const sanitized = normalized
    .replace(/\//g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "");
  const shortHash = crypto.randomBytes(4).toString("hex");
  return `pack-${sanitized}-${shortHash}`;
}

/**
 * Normalize a path for consistent manifest keys.
 * @param {string} p - Path to normalize
 * @returns {string}
 */
function normalizePath(p) {
  // Remove leading/trailing slashes and normalize to forward slashes
  return p
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}
