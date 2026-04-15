/**
 * Tests for pack-manifest.js - manifest CRUD operations.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createManifest,
  getPack,
  setPack,
  removePack,
  listPacks,
  isPathPacked,
  validateManifest,
  generatePackId,
} from "../src/core/pack-manifest.js";

test("createManifest returns empty manifest with correct structure", () => {
  const manifest = createManifest();

  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.packs, {});
});

test("setPack adds new pack entry", () => {
  const manifest = createManifest();

  setPack(manifest, "node_modules", {
    packId: "pack-node_modules-abc123",
    localTreeHash: "sha256:abc",
    fileCount: 100,
  });

  assert.ok(manifest.packs["node_modules"]);
  assert.equal(manifest.packs["node_modules"].packId, "pack-node_modules-abc123");
  assert.equal(manifest.packs["node_modules"].localTreeHash, "sha256:abc");
  assert.equal(manifest.packs["node_modules"].fileCount, 100);
  assert.ok(manifest.packs["node_modules"].lastModified);
});

test("setPack merges with existing pack entry", () => {
  const manifest = createManifest();

  setPack(manifest, "node_modules", {
    packId: "pack-node_modules-abc123",
    localTreeHash: "sha256:abc",
  });

  setPack(manifest, "node_modules", {
    remoteTreeHash: "sha256:def",
    fileCount: 200,
  });

  assert.equal(manifest.packs["node_modules"].packId, "pack-node_modules-abc123");
  assert.equal(manifest.packs["node_modules"].localTreeHash, "sha256:abc");
  assert.equal(manifest.packs["node_modules"].remoteTreeHash, "sha256:def");
  assert.equal(manifest.packs["node_modules"].fileCount, 200);
});

test("getPack returns pack info for existing path", () => {
  const manifest = createManifest();
  setPack(manifest, "vendor", { packId: "pack-vendor-xyz" });

  const pack = getPack(manifest, "vendor");

  assert.ok(pack);
  assert.equal(pack.packId, "pack-vendor-xyz");
});

test("getPack returns null for non-existent path", () => {
  const manifest = createManifest();

  const pack = getPack(manifest, "nonexistent");

  assert.equal(pack, null);
});

test("removePack deletes pack entry", () => {
  const manifest = createManifest();
  setPack(manifest, "node_modules", { packId: "test" });
  setPack(manifest, "vendor", { packId: "test2" });

  removePack(manifest, "node_modules");

  assert.equal(getPack(manifest, "node_modules"), null);
  assert.ok(getPack(manifest, "vendor"));
});

test("listPacks returns all pack entries", () => {
  const manifest = createManifest();
  setPack(manifest, "node_modules", { packId: "pack1" });
  setPack(manifest, "vendor", { packId: "pack2" });
  setPack(manifest, ".git", { packId: "pack3" });

  const packs = listPacks(manifest);

  assert.equal(packs.length, 3);
  assert.ok(packs.find((p) => p.path === "node_modules"));
  assert.ok(packs.find((p) => p.path === "vendor"));
  assert.ok(packs.find((p) => p.path === ".git"));
});

test("isPathPacked returns true for exact pack path", () => {
  const manifest = createManifest();
  setPack(manifest, "node_modules", { packId: "test" });

  const result = isPathPacked(manifest, "node_modules");

  assert.equal(result.isPacked, true);
  assert.equal(result.packPath, "node_modules");
});

test("isPathPacked returns true for nested path", () => {
  const manifest = createManifest();
  setPack(manifest, "node_modules", { packId: "test" });

  const result = isPathPacked(manifest, "node_modules/lodash/index.js");

  assert.equal(result.isPacked, true);
  assert.equal(result.packPath, "node_modules");
});

test("isPathPacked returns false for unrelated path", () => {
  const manifest = createManifest();
  setPack(manifest, "node_modules", { packId: "test" });

  const result = isPathPacked(manifest, "src/index.js");

  assert.equal(result.isPacked, false);
  assert.equal(result.packPath, null);
});

test("isPathPacked handles path normalization", () => {
  const manifest = createManifest();
  setPack(manifest, "node_modules", { packId: "test" });

  // Test with leading/trailing slashes
  assert.equal(isPathPacked(manifest, "/node_modules/").isPacked, true);
  assert.equal(isPathPacked(manifest, "node_modules/").isPacked, true);
  assert.equal(isPathPacked(manifest, "/node_modules").isPacked, true);
});

test("validateManifest accepts valid manifest", () => {
  const manifest = createManifest();
  setPack(manifest, "test", { packId: "pack-test-123" });

  const result = validateManifest(manifest);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateManifest rejects null manifest", () => {
  const result = validateManifest(null);

  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("validateManifest rejects invalid version", () => {
  const result = validateManifest({ version: 999, packs: {} });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("version")));
});

test("validateManifest rejects pack without packId", () => {
  const manifest = {
    version: 1,
    packs: {
      test: { localTreeHash: "sha256:abc" },
    },
  };

  const result = validateManifest(manifest);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("packId")));
});

test("generatePackId creates unique IDs", () => {
  const id1 = generatePackId("node_modules");
  const id2 = generatePackId("node_modules");

  assert.ok(id1.startsWith("pack-node_modules-"));
  assert.ok(id2.startsWith("pack-node_modules-"));
  assert.notEqual(id1, id2); // Different random suffixes
});

test("generatePackId sanitizes path characters", () => {
  const id = generatePackId("path/to/dir");

  assert.ok(id.startsWith("pack-path_to_dir-"));
  assert.ok(!id.includes("/"));
});
