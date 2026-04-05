import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/core/repository.js";
import { initWorkspace } from "../src/core/config.js";

function makeTmpWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-repo-test-"));
  initWorkspace(root, "fake-folder-id", "Test Drive");
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Constructor ──

test("Repository constructor stores root and is not connected", () => {
  const repo = new Repository("/tmp/fake");
  assert.equal(repo.root, "/tmp/fake");
  assert.equal(repo.isConnected, false);
});

test("Repository constructor with pre-authenticated drive skips auth", () => {
  const fakeDrive = { files: {} };
  const repo = new Repository("/tmp/fake", { drive: fakeDrive });
  assert.equal(repo.isConnected, true);
  assert.equal(repo.drive, fakeDrive);
});

test("Repository.drive throws when not connected", () => {
  const repo = new Repository("/tmp/fake");
  assert.throws(() => repo.drive, /not connected/i);
});

// ── Config ──

test("getConfig reads workspace config", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const config = repo.getConfig();
    assert.equal(config.drive_folder_id, "fake-folder-id");
    assert.equal(config.drive_folder_name, "Test Drive");
  } finally {
    cleanup(root);
  }
});

test("getConfig caches after first read", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const config1 = repo.getConfig();
    const config2 = repo.getConfig();
    assert.equal(config1, config2); // same reference
  } finally {
    cleanup(root);
  }
});

test("setConfig invalidates cache", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const config1 = repo.getConfig();
    repo.setConfig({ ...config1, drive_folder_name: "Updated" });
    const config2 = repo.getConfig();
    assert.notEqual(config1, config2);
    assert.equal(config2.drive_folder_name, "Updated");
  } finally {
    cleanup(root);
  }
});

// ── Staging ──

test("getStagedEntries returns empty array initially", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const staged = repo.getStagedEntries();
    assert.deepEqual(staged, []);
  } finally {
    cleanup(root);
  }
});

test("stageChange and getStagedEntries round-trip", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    repo.stageChange({
      path: "test.txt",
      suggestedAction: "download",
      fileId: "abc123",
      remoteMeta: { path: "test.txt" },
    });
    const staged = repo.getStagedEntries();
    assert.equal(staged.length, 1);
    assert.equal(staged[0].path, "test.txt");
    assert.equal(staged[0].action, "download");
  } finally {
    cleanup(root);
  }
});

test("stageChanges stages multiple and returns count", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const count = repo.stageChanges([
      { path: "a.txt", suggestedAction: "download", fileId: "1" },
      { path: "b.txt", suggestedAction: "upload" },
    ]);
    assert.equal(count, 2);
    assert.equal(repo.getStagedEntries().length, 2);
  } finally {
    cleanup(root);
  }
});

test("unstagePath removes a staged entry", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    repo.stageChange({ path: "x.txt", suggestedAction: "download", fileId: "1" });
    assert.equal(repo.unstagePath("x.txt"), true);
    assert.equal(repo.getStagedEntries().length, 0);
  } finally {
    cleanup(root);
  }
});

test("unstagePath returns false for missing entry", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    assert.equal(repo.unstagePath("nope.txt"), false);
  } finally {
    cleanup(root);
  }
});

test("unstageAll clears all staged entries", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    repo.stageChanges([
      { path: "a.txt", suggestedAction: "download", fileId: "1" },
      { path: "b.txt", suggestedAction: "upload" },
    ]);
    const count = repo.unstageAll();
    assert.equal(count, 2);
    assert.equal(repo.getStagedEntries().length, 0);
  } finally {
    cleanup(root);
  }
});

// ── History ──

test("getHistory returns empty array when no snapshots", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    assert.deepEqual(repo.getHistory(), []);
  } finally {
    cleanup(root);
  }
});

test("getSnapshot returns null when no snapshot exists", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    assert.equal(repo.getSnapshot(), null);
  } finally {
    cleanup(root);
  }
});

test("getSnapshotByRef returns null for missing ref", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    assert.equal(repo.getSnapshotByRef("HEAD"), null);
    assert.equal(repo.getSnapshotByRef("2026"), null);
  } finally {
    cleanup(root);
  }
});

// ── Null root (workspace-less) ──

test("Repository with null root can be constructed", () => {
  const repo = new Repository(null);
  assert.equal(repo.root, null);
  assert.equal(repo.isConnected, false);
});
