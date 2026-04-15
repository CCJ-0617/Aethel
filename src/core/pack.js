/**
 * Directory packing operations: tar archive creation/extraction and tree hash.
 */

import * as tar from "tar";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import {
  Algorithm,
  EXTENSIONS,
  createCompressStream,
  createDecompressStream,
  detectAlgorithm,
  resolveAlgorithm,
} from "./compress.js";

/**
 * Calculate tree hash for a directory using mtime + size.
 * This is the key optimization: ~30x faster than MD5 hashing all files.
 * @param {string} dirPath - Directory to hash
 * @returns {Promise<string>} Hash in format "sha256:..."
 */
export async function getTreeHash(dirPath) {
  const entries = [];

  async function walk(currentPath) {
    let items;
    try {
      items = await fsp.readdir(currentPath, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
    }

    for (const item of items) {
      const fullPath = path.join(currentPath, item.name);

      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          const relativePath = path.relative(dirPath, fullPath);
          // Use forward slashes for consistency across platforms
          const normalizedPath = relativePath.replace(/\\/g, "/");
          entries.push(`${normalizedPath}:${stat.mtimeMs}:${stat.size}`);
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  await walk(dirPath);

  // Sort for deterministic hash
  entries.sort();

  const fingerprint = entries.join("\n");
  const hash = crypto.createHash("sha256").update(fingerprint).digest("hex");
  return `sha256:${hash}`;
}

/**
 * Create a pack (tar archive) from a directory.
 * @param {string} sourcePath - Source directory path
 * @param {string} destPath - Destination file path (without extension)
 * @param {{ algorithm?: string, level?: number }} options
 * @returns {Promise<{
 *   packPath: string,
 *   fileCount: number,
 *   originalSize: number,
 *   packedSize: number,
 *   treeHash: string,
 *   compression: { algorithm: string, level: number }
 * }>}
 */
export async function createPack(sourcePath, destPath, options = {}) {
  const preferredAlgorithm = options.algorithm ?? Algorithm.GZIP;
  const level = options.level ?? 6;

  // Resolve to available algorithm
  const algorithm = await resolveAlgorithm(preferredAlgorithm);
  const extension = EXTENSIONS[algorithm];
  const packPath = destPath + extension;

  // Calculate tree hash before packing
  const treeHash = await getTreeHash(sourcePath);

  // Count files and total size
  let fileCount = 0;
  let originalSize = 0;

  async function countFiles(dir) {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        await countFiles(fullPath);
      } else if (item.isFile()) {
        fileCount++;
        const stat = await fsp.stat(fullPath);
        originalSize += stat.size;
      }
    }
  }
  await countFiles(sourcePath);

  // Create tar archive with compression
  const tempTarPath = path.join(os.tmpdir(), `aethel-tar-${Date.now()}.tar`);

  try {
    // Create tar archive
    await tar.create(
      {
        file: tempTarPath,
        cwd: path.dirname(sourcePath),
        gzip: false,
      },
      [path.basename(sourcePath)]
    );

    // Apply compression
    if (algorithm === Algorithm.NONE) {
      // No compression, just rename
      await fsp.rename(tempTarPath, packPath);
    } else {
      const readStream = fs.createReadStream(tempTarPath);
      const writeStream = fs.createWriteStream(packPath);
      const compressStream = await createCompressStream(algorithm, { level });
      await pipeline(readStream, compressStream, writeStream);
      await fsp.unlink(tempTarPath);
    }

    const packStat = await fsp.stat(packPath);

    return {
      packPath,
      fileCount,
      originalSize,
      packedSize: packStat.size,
      treeHash,
      compression: { algorithm, level },
    };
  } catch (err) {
    // Cleanup on error
    try {
      await fsp.unlink(tempTarPath);
    } catch {}
    try {
      await fsp.unlink(packPath);
    } catch {}
    throw err;
  }
}

/**
 * Extract a pack to a destination directory.
 * @param {string} packPath - Pack file path
 * @param {string} destPath - Destination directory path
 * @param {{ algorithm?: string }} options - Algorithm override (auto-detected if not provided)
 * @returns {Promise<{ fileCount: number, extractedSize: number }>}
 */
export async function extractPack(packPath, destPath, options = {}) {
  const algorithm = options.algorithm ?? detectAlgorithm(packPath) ?? Algorithm.GZIP;

  // Ensure destination exists
  await fsp.mkdir(destPath, { recursive: true });

  const tempTarPath = path.join(os.tmpdir(), `aethel-extract-${Date.now()}.tar`);

  try {
    // Decompress if needed
    if (algorithm === Algorithm.NONE) {
      // No decompression needed
      await tar.extract({
        file: packPath,
        cwd: destPath,
        strip: 1, // Remove top-level directory
      });
    } else {
      // Decompress first
      const readStream = fs.createReadStream(packPath);
      const writeStream = fs.createWriteStream(tempTarPath);
      const decompressStream = await createDecompressStream(algorithm);
      await pipeline(readStream, decompressStream, writeStream);

      // Then extract
      await tar.extract({
        file: tempTarPath,
        cwd: destPath,
        strip: 1,
      });

      await fsp.unlink(tempTarPath);
    }

    // Count extracted files
    let fileCount = 0;
    let extractedSize = 0;

    async function countFiles(dir) {
      const items = await fsp.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          await countFiles(fullPath);
        } else if (item.isFile()) {
          fileCount++;
          const stat = await fsp.stat(fullPath);
          extractedSize += stat.size;
        }
      }
    }
    await countFiles(destPath);

    return { fileCount, extractedSize };
  } catch (err) {
    try {
      await fsp.unlink(tempTarPath);
    } catch {}
    throw err;
  }
}

/**
 * Check if a pack is stale (local directory has changed).
 * @param {string} currentHash - Current tree hash of directory
 * @param {string|null} manifestHash - Hash stored in manifest
 * @returns {boolean} True if pack needs to be recreated
 */
export function isPackStale(currentHash, manifestHash) {
  if (!manifestHash) return true;
  return currentHash !== manifestHash;
}

/**
 * List contents of a pack without extracting.
 * @param {string} packPath - Pack file path
 * @returns {Promise<Array<{ path: string, size: number, mtime: Date }>>}
 */
export async function listPackContents(packPath) {
  const algorithm = detectAlgorithm(packPath) ?? Algorithm.GZIP;
  const entries = [];

  if (algorithm === Algorithm.NONE) {
    // Direct tar list
    await tar.list({
      file: packPath,
      onentry: (entry) => {
        entries.push({
          path: entry.path,
          size: entry.size,
          mtime: entry.mtime,
        });
      },
    });
  } else {
    // Need to decompress first
    const tempTarPath = path.join(os.tmpdir(), `aethel-list-${Date.now()}.tar`);
    try {
      const readStream = fs.createReadStream(packPath);
      const writeStream = fs.createWriteStream(tempTarPath);
      const decompressStream = await createDecompressStream(algorithm);
      await pipeline(readStream, decompressStream, writeStream);

      await tar.list({
        file: tempTarPath,
        onentry: (entry) => {
          entries.push({
            path: entry.path,
            size: entry.size,
            mtime: entry.mtime,
          });
        },
      });

      await fsp.unlink(tempTarPath);
    } catch (err) {
      try {
        await fsp.unlink(tempTarPath);
      } catch {}
      throw err;
    }
  }

  return entries;
}

/**
 * Extract a single file from a pack.
 * @param {string} packPath - Pack file path
 * @param {string} filePath - Relative path within the pack
 * @param {string} destPath - Destination path for extracted file
 * @returns {Promise<void>}
 */
export async function extractSingleFile(packPath, filePath, destPath) {
  const algorithm = detectAlgorithm(packPath) ?? Algorithm.GZIP;

  // Ensure destination directory exists
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  const tempDir = path.join(os.tmpdir(), `aethel-single-${Date.now()}`);
  await fsp.mkdir(tempDir, { recursive: true });

  try {
    if (algorithm === Algorithm.NONE) {
      await tar.extract({
        file: packPath,
        cwd: tempDir,
        filter: (p) => p === filePath || p.endsWith("/" + filePath),
      });
    } else {
      // Decompress first
      const tempTarPath = path.join(tempDir, "archive.tar");
      const readStream = fs.createReadStream(packPath);
      const writeStream = fs.createWriteStream(tempTarPath);
      const decompressStream = await createDecompressStream(algorithm);
      await pipeline(readStream, decompressStream, writeStream);

      await tar.extract({
        file: tempTarPath,
        cwd: tempDir,
        filter: (p) => p === filePath || p.endsWith("/" + filePath),
      });
    }

    // Find the extracted file and move it
    async function findFile(dir) {
      const items = await fsp.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          const found = await findFile(fullPath);
          if (found) return found;
        } else if (item.name === path.basename(filePath)) {
          return fullPath;
        }
      }
      return null;
    }

    const extractedPath = await findFile(tempDir);
    if (!extractedPath) {
      throw new Error(`File not found in pack: ${filePath}`);
    }

    await fsp.copyFile(extractedPath, destPath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}
