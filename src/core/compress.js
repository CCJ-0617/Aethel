/**
 * Multi-algorithm compression/decompression abstraction.
 * Supports gzip, brotli (built-in), and optionally zstd, xz.
 */

import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import fs from "node:fs";
import path from "node:path";

// Algorithm enumeration
export const Algorithm = Object.freeze({
  NONE: "none",
  GZIP: "gzip",
  ZSTD: "zstd",
  BROTLI: "brotli",
  XZ: "xz",
});

// File extension mapping
export const EXTENSIONS = {
  [Algorithm.NONE]: ".tar",
  [Algorithm.GZIP]: ".tar.gz",
  [Algorithm.ZSTD]: ".tar.zst",
  [Algorithm.BROTLI]: ".tar.br",
  [Algorithm.XZ]: ".tar.xz",
};

// Compression profiles for easy configuration
export const PROFILES = {
  fast: { algorithm: Algorithm.ZSTD, level: 1 },
  balanced: { algorithm: Algorithm.ZSTD, level: 6 },
  maximum: { algorithm: Algorithm.ZSTD, level: 19 },
  extreme: { algorithm: Algorithm.XZ, level: 6 },
};

// Cache for optional dependency availability
const availabilityCache = new Map();

/**
 * Try to load an optional dependency.
 * @param {string} moduleName
 * @returns {Promise<any|null>}
 */
async function tryLoadModule(moduleName) {
  if (availabilityCache.has(moduleName)) {
    return availabilityCache.get(moduleName);
  }
  try {
    const mod = await import(moduleName);
    availabilityCache.set(moduleName, mod.default || mod);
    return availabilityCache.get(moduleName);
  } catch {
    availabilityCache.set(moduleName, null);
    return null;
  }
}

/**
 * Check if an algorithm is available in the current environment.
 * @param {string} algorithm - Algorithm name from Algorithm enum
 * @returns {Promise<boolean>}
 */
export async function isAlgorithmAvailable(algorithm) {
  switch (algorithm) {
    case Algorithm.NONE:
    case Algorithm.GZIP:
    case Algorithm.BROTLI:
      return true; // Built-in Node.js
    case Algorithm.ZSTD:
      return (await tryLoadModule("@bokuweb/zstd-wasm")) !== null;
    case Algorithm.XZ:
      return (await tryLoadModule("lzma-native")) !== null;
    default:
      return false;
  }
}

/**
 * Get the best available algorithm for compression.
 * Falls back to gzip if preferred is unavailable.
 * @param {string} preferred - Preferred algorithm
 * @returns {Promise<string>} Available algorithm
 */
export async function resolveAlgorithm(preferred) {
  if (await isAlgorithmAvailable(preferred)) {
    return preferred;
  }
  // Fallback chain: zstd -> gzip
  if (preferred !== Algorithm.ZSTD && (await isAlgorithmAvailable(Algorithm.ZSTD))) {
    return Algorithm.ZSTD;
  }
  return Algorithm.GZIP;
}

/**
 * Create a compression stream for the given algorithm.
 * @param {string} algorithm - Algorithm name
 * @param {{ level?: number }} options - Compression options
 * @returns {Promise<import("node:stream").Transform>} Compression stream
 */
export async function createCompressStream(algorithm, options = {}) {
  const level = options.level ?? 6;

  switch (algorithm) {
    case Algorithm.NONE:
      // Pass-through stream
      const { PassThrough } = await import("node:stream");
      return new PassThrough();

    case Algorithm.GZIP:
      return zlib.createGzip({ level });

    case Algorithm.BROTLI:
      return zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: Math.min(level, 11),
        },
      });

    case Algorithm.ZSTD: {
      const zstd = await tryLoadModule("@bokuweb/zstd-wasm");
      if (!zstd) {
        throw new Error("zstd not available. Install @bokuweb/zstd-wasm");
      }
      // zstd-wasm provides compress/decompress functions, not streams
      // We need to wrap it in a transform stream
      const { Transform } = await import("node:stream");
      const chunks = [];
      return new Transform({
        transform(chunk, encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        async flush(callback) {
          try {
            const input = Buffer.concat(chunks);
            const compressed = await zstd.compress(input, level);
            this.push(Buffer.from(compressed));
            callback();
          } catch (err) {
            callback(err);
          }
        },
      });
    }

    case Algorithm.XZ: {
      const lzma = await tryLoadModule("lzma-native");
      if (!lzma) {
        throw new Error("xz not available. Install lzma-native");
      }
      return lzma.createCompressor({ preset: level });
    }

    default:
      throw new Error(`Unknown compression algorithm: ${algorithm}`);
  }
}

/**
 * Create a decompression stream for the given algorithm.
 * @param {string} algorithm - Algorithm name
 * @returns {Promise<import("node:stream").Transform>} Decompression stream
 */
export async function createDecompressStream(algorithm) {
  switch (algorithm) {
    case Algorithm.NONE: {
      const { PassThrough } = await import("node:stream");
      return new PassThrough();
    }

    case Algorithm.GZIP:
      return zlib.createGunzip();

    case Algorithm.BROTLI:
      return zlib.createBrotliDecompress();

    case Algorithm.ZSTD: {
      const zstd = await tryLoadModule("@bokuweb/zstd-wasm");
      if (!zstd) {
        throw new Error("zstd not available. Install @bokuweb/zstd-wasm");
      }
      const { Transform } = await import("node:stream");
      const chunks = [];
      return new Transform({
        transform(chunk, encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        async flush(callback) {
          try {
            const input = Buffer.concat(chunks);
            const decompressed = await zstd.decompress(input);
            this.push(Buffer.from(decompressed));
            callback();
          } catch (err) {
            callback(err);
          }
        },
      });
    }

    case Algorithm.XZ: {
      const lzma = await tryLoadModule("lzma-native");
      if (!lzma) {
        throw new Error("xz not available. Install lzma-native");
      }
      return lzma.createDecompressor();
    }

    default:
      throw new Error(`Unknown decompression algorithm: ${algorithm}`);
  }
}

/**
 * Compress a file to destination.
 * @param {string} inputPath - Source file path
 * @param {string} outputPath - Destination file path
 * @param {{ algorithm?: string, level?: number }} options
 * @returns {Promise<{ originalSize: number, compressedSize: number, ratio: number }>}
 */
export async function compressFile(inputPath, outputPath, options = {}) {
  const algorithm = options.algorithm ?? Algorithm.GZIP;
  const level = options.level ?? 6;

  const inputStat = fs.statSync(inputPath);
  const originalSize = inputStat.size;

  const readStream = fs.createReadStream(inputPath);
  const writeStream = fs.createWriteStream(outputPath);
  const compressStream = await createCompressStream(algorithm, { level });

  await pipeline(readStream, compressStream, writeStream);

  const outputStat = fs.statSync(outputPath);
  const compressedSize = outputStat.size;
  const ratio = originalSize > 0 ? 1 - compressedSize / originalSize : 0;

  return { originalSize, compressedSize, ratio };
}

/**
 * Decompress a file to destination.
 * @param {string} inputPath - Compressed file path
 * @param {string} outputPath - Destination file path
 * @param {string} algorithm - Algorithm used for compression
 * @returns {Promise<void>}
 */
export async function decompressFile(inputPath, outputPath, algorithm) {
  const readStream = fs.createReadStream(inputPath);
  const writeStream = fs.createWriteStream(outputPath);
  const decompressStream = await createDecompressStream(algorithm);

  await pipeline(readStream, decompressStream, writeStream);
}

/**
 * Detect algorithm from file extension.
 * @param {string} filePath - File path with extension
 * @returns {string|null} Algorithm name or null if unknown
 */
export function detectAlgorithm(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fullExt = filePath.toLowerCase();

  if (fullExt.endsWith(".tar.gz") || fullExt.endsWith(".tgz")) {
    return Algorithm.GZIP;
  }
  if (fullExt.endsWith(".tar.zst")) {
    return Algorithm.ZSTD;
  }
  if (fullExt.endsWith(".tar.br")) {
    return Algorithm.BROTLI;
  }
  if (fullExt.endsWith(".tar.xz")) {
    return Algorithm.XZ;
  }
  if (ext === ".tar") {
    return Algorithm.NONE;
  }

  return null;
}
