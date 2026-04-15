/**
 * Tests for pack-aware scanning and diff (Stage 2 integration).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scanLocal, buildSnapshot } from "../src/core/snapshot.js";
import { computeDiff, ChangeType } from "../src/core/diff.js";
import { initWorkspace, savePackConfig, savePackManifest, loadPackManifest } from "../src/core/config.js";
import { createManifest, setPack } from "../src/core/pack-manifest.js";

/**
 * Create a test workspace with pack config enabled.
 */
async function createTestWorkspace(basePath, packRules = []) {
  const root = path.join(basePath, "workspace");
  await fs.mkdir(root, { recursive: true });

  // Initialize aethel workspace
  initWorkspace(root, "test-drive-id", "Test Drive");

  // Create pack config if rules provided
  if (packRules.length > 0) {
    savePackConfig(root, {
      packing: {
        enabled: true,
        compression: {
          default: { algorithm: "gzip", level: 6 },
        },
        rules: packRules,
      },
    });
  }

  return root;
}

/**
 * Create a directory with sample files.
 */
async function createDir(basePath, name, files = {}) {
  const dirPath = path.join(basePath, name);
  await fs.mkdir(dirPath, { recursive: true });

  for (const [fileName, content] of Object.entries(files)) {
    const filePath = path.join(dirPath, fileName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  return dirPath;
}

test("scanLocal returns both files and packedDirs when packing enabled", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-int-test-"));

  try {
    const root = await createTestWorkspace(tempDir, [
      { path: "node_modules", strategy: "full" },
    ]);

    // Create regular files
    await fs.writeFile(path.join(root, "index.js"), "console.log('hello');");
    await fs.writeFile(path.join(root, "README.md"), "# Test");

    // Create node_modules (should be packed)
    await createDir(root, "node_modules", {
      "lodash/index.js": "module.exports = {};",
      "lodash/package.json": '{"name": "lodash"}',
    });

    const result = await scanLocal(root);

    // Should have files property
    assert.ok(result.files);
    assert.ok(result.files["index.js"]);
    assert.ok(result.files["README.md"]);

    // node_modules files should NOT be in files
    assert.ok(!result.files["node_modules/lodash/index.js"]);

    // Should have packedDirs property
    assert.ok(result.packedDirs);
    assert.ok(result.packedDirs["node_modules"]);
    assert.equal(result.packedDirs["node_modules"].isPacked, true);
    assert.ok(result.packedDirs["node_modules"].treeHash.startsWith("sha256:"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("scanLocal scans all files when packing disabled", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-int-test-"));

  try {
    const root = await createTestWorkspace(tempDir, []); // No pack rules

    await fs.writeFile(path.join(root, "index.js"), "console.log('hello');");
    await createDir(root, "vendor", {
      "lib.js": "module.exports = {};",
    });

    const result = await scanLocal(root);

    // All files should be scanned
    assert.ok(result.files["index.js"]);
    assert.ok(result.files["vendor/lib.js"]);

    // No packed dirs
    assert.deepEqual(result.packedDirs, {});
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("scanLocal with respectPacking=false and respectIgnore=false scans all files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-int-test-"));

  try {
    const root = await createTestWorkspace(tempDir, [
      { path: "node_modules", strategy: "full" },
    ]);

    await fs.writeFile(path.join(root, "index.js"), "console.log('hello');");
    await createDir(root, "node_modules", {
      "lodash/index.js": "module.exports = {};",
    });

    // When both packing AND ignore are disabled, all files are scanned
    const result = await scanLocal(root, { respectPacking: false, respectIgnore: false });

    // All files should be scanned including node_modules
    assert.ok(result.files["index.js"]);
    assert.ok(result.files["node_modules/lodash/index.js"]);

    // No packed dirs when packing disabled
    assert.deepEqual(result.packedDirs, {});
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildSnapshot includes packedDirs", async () => {
  const localFiles = {
    files: {
      "index.js": { localPath: "index.js", size: 100, md5: "abc123" },
    },
    packedDirs: {
      "node_modules": {
        path: "node_modules",
        isPacked: true,
        treeHash: "sha256:xyz",
      },
    },
  };

  const snapshot = buildSnapshot([], localFiles, "test snapshot");

  assert.ok(snapshot.localFiles["index.js"]);
  assert.ok(snapshot.packedDirs["node_modules"]);
  assert.equal(snapshot.packedDirs["node_modules"].treeHash, "sha256:xyz");
});

test("computeDiff detects PACK_NEW for unsynced pack", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-int-test-"));

  try {
    const root = await createTestWorkspace(tempDir, [
      { path: "node_modules", strategy: "full" },
    ]);

    await createDir(root, "node_modules", {
      "lodash/index.js": "module.exports = {};",
    });

    const localFiles = await scanLocal(root);
    const snapshot = null; // No previous snapshot

    const diff = computeDiff(snapshot, [], localFiles, { root });

    assert.ok(diff.packChanges.length > 0);
    const packNew = diff.packChanges.find(
      (c) => c.changeType === ChangeType.PACK_NEW
    );
    assert.ok(packNew);
    assert.equal(packNew.path, "node_modules");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("computeDiff detects PACK_LOCAL_MODIFIED when local pack changed", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-int-test-"));

  try {
    const root = await createTestWorkspace(tempDir, [
      { path: "node_modules", strategy: "full" },
    ]);

    await createDir(root, "node_modules", {
      "lodash/index.js": "module.exports = {};",
    });

    // Scan to get initial tree hash
    const localFiles1 = await scanLocal(root);
    const initialHash = localFiles1.packedDirs["node_modules"].treeHash;

    // Create manifest with initial hash
    const manifest = createManifest();
    setPack(manifest, "node_modules", {
      packId: "pack-node_modules-test",
      localTreeHash: initialHash,
      remoteTreeHash: initialHash,
    });
    savePackManifest(root, manifest);

    // Modify a file in node_modules
    await new Promise((r) => setTimeout(r, 10)); // Ensure mtime changes
    await fs.writeFile(
      path.join(root, "node_modules/lodash/index.js"),
      "module.exports = { modified: true };"
    );

    // Rescan
    const localFiles2 = await scanLocal(root);
    const diff = computeDiff(null, [], localFiles2, { root });

    const packModified = diff.packChanges.find(
      (c) => c.changeType === ChangeType.PACK_LOCAL_MODIFIED
    );
    assert.ok(packModified);
    assert.equal(packModified.path, "node_modules");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("computeDiff detects PACK_SYNCED when pack unchanged", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-int-test-"));

  try {
    const root = await createTestWorkspace(tempDir, [
      { path: "node_modules", strategy: "full" },
    ]);

    await createDir(root, "node_modules", {
      "lodash/index.js": "module.exports = {};",
    });

    const localFiles = await scanLocal(root);
    const hash = localFiles.packedDirs["node_modules"].treeHash;

    // Create manifest with same hash
    const manifest = createManifest();
    setPack(manifest, "node_modules", {
      packId: "pack-node_modules-test",
      localTreeHash: hash,
      remoteTreeHash: hash,
    });
    savePackManifest(root, manifest);

    const diff = computeDiff(null, [], localFiles, { root });

    const packSynced = diff.packChanges.find(
      (c) => c.changeType === ChangeType.PACK_SYNCED
    );
    assert.ok(packSynced);
    assert.equal(packSynced.path, "node_modules");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("computeDiff handles both regular files and pack changes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-int-test-"));

  try {
    const root = await createTestWorkspace(tempDir, [
      { path: "node_modules", strategy: "full" },
    ]);

    await fs.writeFile(path.join(root, "index.js"), "console.log('hello');");
    await createDir(root, "node_modules", {
      "lodash/index.js": "module.exports = {};",
    });

    const localFiles = await scanLocal(root);

    // No snapshot = all local files are new
    const diff = computeDiff(null, [], localFiles, { root });

    // Should have local file changes
    assert.ok(diff.localChanges.length > 0);
    assert.ok(diff.changes.some((c) => c.path === "index.js"));

    // Should have pack changes
    assert.ok(diff.packChanges.length > 0);
    assert.ok(diff.packChanges.some((c) => c.path === "node_modules"));

    // isClean should be false
    assert.equal(diff.isClean, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("diff result has correct pack helper methods", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-int-test-"));

  try {
    const root = await createTestWorkspace(tempDir, [
      { path: "vendor", strategy: "full" },
    ]);

    await createDir(root, "vendor", { "lib.js": "export default {};" });

    const localFiles = await scanLocal(root);
    const diff = computeDiff(null, [], localFiles, { root });

    // Test helper methods exist and work
    assert.ok(Array.isArray(diff.packConflicts));
    assert.ok(Array.isArray(diff.pendingPackChanges));
    assert.ok(Array.isArray(diff.syncedPacks));
    assert.equal(typeof diff.hasPackChanges, "boolean");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
