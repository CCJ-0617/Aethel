/**
 * Tests for compress.js - multi-algorithm compression module.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Algorithm,
  EXTENSIONS,
  PROFILES,
  isAlgorithmAvailable,
  resolveAlgorithm,
  compressFile,
  decompressFile,
  detectAlgorithm,
} from "../src/core/compress.js";

test("Algorithm enum has expected values", () => {
  assert.equal(Algorithm.NONE, "none");
  assert.equal(Algorithm.GZIP, "gzip");
  assert.equal(Algorithm.ZSTD, "zstd");
  assert.equal(Algorithm.BROTLI, "brotli");
  assert.equal(Algorithm.XZ, "xz");
});

test("EXTENSIONS maps algorithms to correct file extensions", () => {
  assert.equal(EXTENSIONS[Algorithm.NONE], ".tar");
  assert.equal(EXTENSIONS[Algorithm.GZIP], ".tar.gz");
  assert.equal(EXTENSIONS[Algorithm.ZSTD], ".tar.zst");
  assert.equal(EXTENSIONS[Algorithm.BROTLI], ".tar.br");
  assert.equal(EXTENSIONS[Algorithm.XZ], ".tar.xz");
});

test("PROFILES has expected presets", () => {
  assert.deepEqual(PROFILES.fast, { algorithm: Algorithm.ZSTD, level: 1 });
  assert.deepEqual(PROFILES.balanced, { algorithm: Algorithm.ZSTD, level: 6 });
  assert.deepEqual(PROFILES.maximum, { algorithm: Algorithm.ZSTD, level: 19 });
  assert.deepEqual(PROFILES.extreme, { algorithm: Algorithm.XZ, level: 6 });
});

test("isAlgorithmAvailable returns true for built-in algorithms", async () => {
  assert.equal(await isAlgorithmAvailable(Algorithm.NONE), true);
  assert.equal(await isAlgorithmAvailable(Algorithm.GZIP), true);
  assert.equal(await isAlgorithmAvailable(Algorithm.BROTLI), true);
});

test("isAlgorithmAvailable returns false for unknown algorithm", async () => {
  assert.equal(await isAlgorithmAvailable("unknown"), false);
});

test("resolveAlgorithm returns gzip when it is preferred", async () => {
  assert.equal(await resolveAlgorithm(Algorithm.GZIP), Algorithm.GZIP);
});

test("resolveAlgorithm returns brotli when it is preferred", async () => {
  assert.equal(await resolveAlgorithm(Algorithm.BROTLI), Algorithm.BROTLI);
});

test("detectAlgorithm identifies gzip from .tar.gz extension", () => {
  assert.equal(detectAlgorithm("archive.tar.gz"), Algorithm.GZIP);
  assert.equal(detectAlgorithm("archive.tgz"), Algorithm.GZIP);
  assert.equal(detectAlgorithm("/path/to/file.tar.gz"), Algorithm.GZIP);
});

test("detectAlgorithm identifies zstd from .tar.zst extension", () => {
  assert.equal(detectAlgorithm("archive.tar.zst"), Algorithm.ZSTD);
});

test("detectAlgorithm identifies brotli from .tar.br extension", () => {
  assert.equal(detectAlgorithm("archive.tar.br"), Algorithm.BROTLI);
});

test("detectAlgorithm identifies xz from .tar.xz extension", () => {
  assert.equal(detectAlgorithm("archive.tar.xz"), Algorithm.XZ);
});

test("detectAlgorithm identifies none from .tar extension", () => {
  assert.equal(detectAlgorithm("archive.tar"), Algorithm.NONE);
});

test("detectAlgorithm returns null for unknown extension", () => {
  assert.equal(detectAlgorithm("archive.zip"), null);
  assert.equal(detectAlgorithm("file.txt"), null);
});

test("compressFile and decompressFile roundtrip with gzip", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "compress-test-"));

  try {
    const originalPath = path.join(tempDir, "original.txt");
    const compressedPath = path.join(tempDir, "compressed.gz");
    const decompressedPath = path.join(tempDir, "decompressed.txt");

    // Create a test file
    const content = "Hello, World!\n".repeat(100);
    await fs.writeFile(originalPath, content);

    // Compress
    const result = await compressFile(originalPath, compressedPath, {
      algorithm: Algorithm.GZIP,
      level: 6,
    });

    assert.ok(result.originalSize > 0);
    assert.ok(result.compressedSize > 0);
    assert.ok(result.compressedSize < result.originalSize);
    assert.ok(result.ratio > 0);

    // Decompress
    await decompressFile(compressedPath, decompressedPath, Algorithm.GZIP);

    // Verify content
    const decompressed = await fs.readFile(decompressedPath, "utf-8");
    assert.equal(decompressed, content);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("compressFile and decompressFile roundtrip with brotli", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "compress-test-"));

  try {
    const originalPath = path.join(tempDir, "original.txt");
    const compressedPath = path.join(tempDir, "compressed.br");
    const decompressedPath = path.join(tempDir, "decompressed.txt");

    const content = "Brotli compression test!\n".repeat(50);
    await fs.writeFile(originalPath, content);

    // Compress
    const result = await compressFile(originalPath, compressedPath, {
      algorithm: Algorithm.BROTLI,
      level: 4,
    });

    assert.ok(result.originalSize > 0);
    assert.ok(result.compressedSize > 0);

    // Decompress
    await decompressFile(compressedPath, decompressedPath, Algorithm.BROTLI);

    // Verify content
    const decompressed = await fs.readFile(decompressedPath, "utf-8");
    assert.equal(decompressed, content);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
