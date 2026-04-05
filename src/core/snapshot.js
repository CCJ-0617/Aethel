import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AETHEL_DIR } from "./config.js";
import { loadIgnoreRules } from "./ignore.js";

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

const PARALLEL_HASH_LIMIT = 128;

export async function scanLocal(root, { respectIgnore = true } = {}) {
  const resolvedRoot = path.resolve(root);
  const ignoreRules = respectIgnore ? loadIgnoreRules(resolvedRoot) : null;
  const hashCache = loadHashCache(resolvedRoot);
  const nextCache = new Map();

  // Phase 1: collect all file stats (fast — no hashing yet)
  const filesToHash = [];
  // Track directories and their child counts to detect empty folders
  const dirChildCount = new Map();
  // Map relative dir path → absolute path (for deferred stat on empty dirs only)
  const dirAbsPath = new Map();

  async function walk(currentPath) {
    let entries;
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    const relativeDirPath = currentPath === resolvedRoot
      ? null
      : path.relative(resolvedRoot, currentPath).split(path.sep).join("/");

    // Register this directory (skip root itself)
    if (relativeDirPath !== null) {
      if (!dirChildCount.has(relativeDirPath)) {
        dirChildCount.set(relativeDirPath, 0);
        dirAbsPath.set(relativeDirPath, currentPath);
      }
    }

    const subdirs = [];
    const statPromises = [];
    let trackedChildren = 0;

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path
        .relative(resolvedRoot, fullPath)
        .split(path.sep)
        .join("/");

      if (ignoreRules?.ignores(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        trackedChildren++;
        subdirs.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      trackedChildren++;
      statPromises.push(
        fs.promises.stat(fullPath).then((stat) => {
          filesToHash.push({ fullPath, relativePath, stat });
        })
      );
    }

    if (relativeDirPath !== null) {
      dirChildCount.set(relativeDirPath, trackedChildren);
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

  // Phase 3: detect empty folders (directories with zero tracked children)
  // Walk bottom-up: a dir is "empty" if it has no tracked children AND
  // all its subdirectories are also empty.
  const emptyDirs = new Set();
  // Sort by depth (deepest first) for bottom-up processing
  const sortedDirs = [...dirChildCount.keys()].sort(
    (a, b) => b.split("/").length - a.split("/").length
  );

  for (const dirPath of sortedDirs) {
    const childCount = dirChildCount.get(dirPath);
    if (childCount === 0) {
      emptyDirs.add(dirPath);
      // Propagate: decrement parent's tracked child count since this child is empty
      const parentDir = dirPath.includes("/")
        ? dirPath.slice(0, dirPath.lastIndexOf("/"))
        : null;
      if (parentDir && dirChildCount.has(parentDir)) {
        dirChildCount.set(parentDir, dirChildCount.get(parentDir) - 1);
      }
    }
  }

  // Only stat the empty directories (not all directories)
  await Promise.all([...emptyDirs].map(async (dirPath) => {
    let mtime = new Date().toISOString();
    const absPath = dirAbsPath.get(dirPath);
    if (absPath) {
      try {
        const stat = await fs.promises.stat(absPath);
        mtime = new Date(stat.mtimeMs).toISOString();
      } catch { /* ignore */ }
    }
    result[dirPath] = {
      localPath: dirPath,
      isFolder: true,
      size: 0,
      md5: null,
      modifiedTime: mtime,
    };
  }));

  // Persist updated cache
  saveHashCache(resolvedRoot, nextCache);
  return result;
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

export function buildSnapshot(remoteFiles, localFiles, message = "") {
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
      ...(file.isFolder ? { isFolder: true } : {}),
    };
  }

  return {
    timestamp: new Date().toISOString(),
    message,
    files,
    localFiles: { ...localFiles },
  };
}
