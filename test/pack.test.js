/**
 * Tests for pack.js - tar operations and tree hash.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getTreeHash,
  createPack,
  extractPack,
  isPackStale,
  listPackContents,
} from "../src/core/pack.js";
import { Algorithm } from "../src/core/compress.js";

/**
 * Create a test directory with sample files.
 */
async function createTestDir(basePath) {
  const testDir = path.join(basePath, "test-dir");
  await fs.mkdir(testDir, { recursive: true });

  // Create some files
  await fs.writeFile(path.join(testDir, "file1.txt"), "Hello World");
  await fs.writeFile(path.join(testDir, "file2.txt"), "Goodbye World");

  // Create a subdirectory with files
  const subDir = path.join(testDir, "subdir");
  await fs.mkdir(subDir);
  await fs.writeFile(path.join(subDir, "nested.txt"), "Nested content");

  return testDir;
}

test("getTreeHash returns deterministic hash for same directory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const testDir = await createTestDir(tempDir);

    const hash1 = await getTreeHash(testDir);
    const hash2 = await getTreeHash(testDir);

    assert.equal(hash1, hash2);
    assert.ok(hash1.startsWith("sha256:"));
    assert.equal(hash1.length, 7 + 64); // "sha256:" + 64 hex chars
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("getTreeHash changes when file is modified", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const testDir = await createTestDir(tempDir);

    const hash1 = await getTreeHash(testDir);

    // Modify a file (change content and mtime)
    await new Promise((r) => setTimeout(r, 10)); // Ensure mtime changes
    await fs.writeFile(path.join(testDir, "file1.txt"), "Modified content");

    const hash2 = await getTreeHash(testDir);

    assert.notEqual(hash1, hash2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("getTreeHash changes when file is added", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const testDir = await createTestDir(tempDir);

    const hash1 = await getTreeHash(testDir);

    // Add a new file
    await fs.writeFile(path.join(testDir, "new-file.txt"), "New content");

    const hash2 = await getTreeHash(testDir);

    assert.notEqual(hash1, hash2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("getTreeHash handles empty directory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const emptyDir = path.join(tempDir, "empty");
    await fs.mkdir(emptyDir);

    const hash = await getTreeHash(emptyDir);

    assert.ok(hash.startsWith("sha256:"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("createPack creates a valid tar.gz archive", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const testDir = await createTestDir(tempDir);
    const packPath = path.join(tempDir, "archive");

    const result = await createPack(testDir, packPath, {
      algorithm: Algorithm.GZIP,
      level: 6,
    });

    assert.ok(result.packPath.endsWith(".tar.gz"));
    assert.ok(await fileExists(result.packPath));
    assert.equal(result.fileCount, 3); // file1.txt, file2.txt, nested.txt
    assert.ok(result.originalSize > 0);
    assert.ok(result.packedSize > 0);
    assert.ok(result.treeHash.startsWith("sha256:"));
    assert.equal(result.compression.algorithm, Algorithm.GZIP);
    assert.equal(result.compression.level, 6);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("createPack creates uncompressed archive with Algorithm.NONE", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const testDir = await createTestDir(tempDir);
    const packPath = path.join(tempDir, "archive");

    const result = await createPack(testDir, packPath, {
      algorithm: Algorithm.NONE,
    });

    assert.ok(result.packPath.endsWith(".tar"));
    assert.ok(await fileExists(result.packPath));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("extractPack restores files from archive", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const testDir = await createTestDir(tempDir);
    const packPath = path.join(tempDir, "archive");
    const extractDir = path.join(tempDir, "extracted");

    // Create pack
    const packResult = await createPack(testDir, packPath, {
      algorithm: Algorithm.GZIP,
    });

    // Extract pack
    const extractResult = await extractPack(packResult.packPath, extractDir);

    assert.ok(extractResult.fileCount > 0);
    assert.ok(extractResult.extractedSize > 0);

    // Verify files exist
    assert.ok(await fileExists(path.join(extractDir, "file1.txt")));
    assert.ok(await fileExists(path.join(extractDir, "file2.txt")));
    assert.ok(await fileExists(path.join(extractDir, "subdir", "nested.txt")));

    // Verify content
    const content = await fs.readFile(path.join(extractDir, "file1.txt"), "utf-8");
    assert.equal(content, "Hello World");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("createPack and extractPack roundtrip preserves content", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const testDir = await createTestDir(tempDir);
    const packPath = path.join(tempDir, "archive");
    const extractDir = path.join(tempDir, "extracted");

    // Create pack
    const packResult = await createPack(testDir, packPath, {
      algorithm: Algorithm.GZIP,
    });

    // Extract pack
    await extractPack(packResult.packPath, extractDir);

    // Compare tree hashes
    const originalHash = await getTreeHash(testDir);
    const extractedHash = await getTreeHash(extractDir);

    assert.equal(originalHash, extractedHash);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("isPackStale returns true when hash is null", () => {
  assert.equal(isPackStale("sha256:abc", null), true);
});

test("isPackStale returns true when hashes differ", () => {
  assert.equal(isPackStale("sha256:abc", "sha256:def"), true);
});

test("isPackStale returns false when hashes match", () => {
  assert.equal(isPackStale("sha256:abc", "sha256:abc"), false);
});

test("listPackContents returns file entries", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const testDir = await createTestDir(tempDir);
    const packPath = path.join(tempDir, "archive");

    const packResult = await createPack(testDir, packPath, {
      algorithm: Algorithm.GZIP,
    });

    const contents = await listPackContents(packResult.packPath);

    assert.ok(contents.length > 0);
    // Contents include the directory entries and files
    const filePaths = contents.map((c) => c.path);
    assert.ok(filePaths.some((p) => p.includes("file1.txt")));
    assert.ok(filePaths.some((p) => p.includes("file2.txt")));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("createPack handles directory with special characters", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-test-"));

  try {
    const testDir = path.join(tempDir, "test-dir");
    await fs.mkdir(testDir);

    // Create files with special names
    await fs.writeFile(path.join(testDir, "file with spaces.txt"), "content");
    await fs.writeFile(path.join(testDir, "file-with-dashes.txt"), "content");
    await fs.writeFile(path.join(testDir, "file_with_underscores.txt"), "content");

    const packPath = path.join(tempDir, "archive");
    const result = await createPack(testDir, packPath, {
      algorithm: Algorithm.GZIP,
    });

    assert.ok(result.fileCount === 3);
    assert.ok(await fileExists(result.packPath));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

/**
 * Helper to check if file exists.
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
