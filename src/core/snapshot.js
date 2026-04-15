import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AETHEL_DIR, loadPackConfig, getPackRule } from "./config.js";
import { loadIgnoreRules } from "./ignore.js";
import { getTreeHash } from "./pack.js";

const HASH_CACHE_FILE = ".hash-cache.json";

export async function md5Local(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// ── Hash cache ───────────────────────────────────────────────────────

function hashCachePath(root) {
  return path.join(root, AETHEL_DIR, HASH_CACHE_FILE);
}

function loadHashCache(root) {
  const p = hashCachePath(root);
  if (!fs.existsSync(p)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveHashCache(root, cache) {
  const p = hashCachePath(root);
  const obj = Object.fromEntries(cache);
  fs.writeFileSync(p, JSON.stringify(obj) + "\n");
}

// ── Scanning ─────────────────────────────────────────────────────────

const PARALLEL_HASH_LIMIT = 32;

export async function scanLocal(root, { respectIgnore = true, respectPacking = true } = {}) {
  const resolvedRoot = path.resolve(root);
  const ignoreRules = respectIgnore ? loadIgnoreRules(resolvedRoot) : null;
  const packConfig = respectPacking ? loadPackConfig(resolvedRoot) : null;
  const packingEnabled = packConfig?.packing?.enabled === true;
  const hashCache = loadHashCache(resolvedRoot);
  const nextCache = new Map();

  // Phase 1: collect all file stats (fast — no hashing yet)
  const filesToHash = [];
  const packedDirs = {};

  async function walk(currentPath) {
    let entries;
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirs = [];
    const statPromises = [];

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path
        .relative(resolvedRoot, fullPath)
        .split(path.sep)
        .join("/");

      if (entry.isDirectory()) {
        // Check if this directory is a pack target BEFORE checking ignore rules
        // Pack targets should be processed even if they match ignore patterns
        if (packingEnabled) {
          const packRule = getPackRule(packConfig, relativePath);
          if (packRule && packRule.path === relativePath) {
            // This directory should be packed - compute tree hash instead of scanning
            try {
              const treeHash = await getTreeHash(fullPath);
              packedDirs[relativePath] = {
                path: relativePath,
                isPacked: true,
                treeHash,
                packRule: packRule.strategy || "full",
              };
            } catch {
              // If we can't compute tree hash, fall back to normal scanning
              if (!ignoreRules?.ignores(relativePath)) {
                subdirs.push(fullPath);
              }
            }
            continue; // Don't descend into packed directory
          }
        }

        // Apply ignore rules for non-pack directories
        if (ignoreRules?.ignores(relativePath)) {
          continue;
        }
        subdirs.push(fullPath);
        continue;
      }

      // Apply ignore rules for files
      if (ignoreRules?.ignores(relativePath)) {
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      statPromises.push(
        fs.promises.stat(fullPath).then((stat) => {
          filesToHash.push({ fullPath, relativePath, stat });
        })
      );
    }

    await Promise.all([
      ...statPromises,
      ...subdirs.map((dir) => walk(dir)),
    ]);
  }

  await walk(resolvedRoot);

  // Phase 2: hash files in parallel batches, using cache when possible
  const result = {};

  for (let i = 0; i < filesToHash.length; i += PARALLEL_HASH_LIMIT) {
    const batch = filesToHash.slice(i, i + PARALLEL_HASH_LIMIT);
    const hashes = await Promise.all(
      batch.map(async ({ fullPath, relativePath, stat }) => {
        const md5 = await getMd5Cached(hashCache, nextCache, fullPath, relativePath, stat);
        return { relativePath, stat, md5 };
      })
    );

    for (const { relativePath, stat, md5 } of hashes) {
      result[relativePath] = {
        localPath: relativePath,
        size: stat.size,
        md5,
        modifiedTime: new Date(stat.mtimeMs).toISOString(),
      };
    }
  }

  // Persist updated cache
  saveHashCache(resolvedRoot, nextCache);

  // Return both files and packed directories
  return {
    files: result,
    packedDirs,
    // For backward compatibility, also expose files at top level
    ...result,
  };
}

async function getMd5Cached(oldCache, newCache, fullPath, relativePath, stat) {
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = oldCache.get(relativePath);

  let md5;
  if (cached && cached.startsWith(key + ":")) {
    // Cache hit: mtime and size match
    md5 = cached.slice(key.length + 1);
  } else {
    // Cache miss: compute hash
    md5 = await md5Local(fullPath);
  }

  newCache.set(relativePath, `${key}:${md5}`);
  return md5;
}

// ── Snapshot building ────────────────────────────────────────────────

export function buildSnapshot(remoteFiles, localFiles, message = "", packedDirs = {}) {
  const files = {};

  for (const file of remoteFiles) {
    files[file.id] = {
      id: file.id,
      name: file.name,
      path: file.path,
      md5Checksum: file.md5Checksum ?? null,
      size: file.size ?? null,
      mimeType: file.mimeType || "",
      modifiedTime: file.modifiedTime ?? null,
      localPath: file.path,
    };
  }

  // Handle localFiles which may be the new format with .files property
  const localFilesData = localFiles?.files ?? localFiles;
  const localPackedDirs = localFiles?.packedDirs ?? packedDirs;

  return {
    timestamp: new Date().toISOString(),
    message,
    files,
    localFiles: { ...localFilesData },
    packedDirs: { ...localPackedDirs },
  };
}
