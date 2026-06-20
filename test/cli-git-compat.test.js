import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initWorkspace, readIndex, writeIndex, writeSnapshot } from "../src/core/config.js";

const cliPath = path.resolve("src", "cli.js");

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    ...options,
  });
}

test("remote -v reports Drive fetch and push refs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-remote-test-"));
  try {
    const clone = runCli(["clone", "drive://abc123", root, "--no-checkout"]);
    assert.equal(clone.status, 0, clone.stderr);

    const remote = runCli(["remote", "-v"], { cwd: root });
    assert.equal(remote.status, 0, remote.stderr);
    assert.match(remote.stdout, /origin\s+drive:\/\/abc123 \(fetch\)/);
    assert.match(remote.stdout, /origin\s+drive:\/\/abc123 \(push\)/);

    const missing = runCli(["remote", "get-url", "upstream"], { cwd: root });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Unknown remote 'upstream'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("top-level version uses --version so command-level -v remains available", () => {
  const version = runCli(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /\d+\.\d+\.\d+/);

  const shortVersion = runCli(["-v"]);
  assert.notEqual(shortVersion.status, 0);
  assert.match(shortVersion.stderr, /unknown option '-v'/);
});

test("clean supports ignored remote cleanup mode", () => {
  const help = runCli(["clean", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--ignored/);
});

test("push and pull expose debug dry-run diagnostics options", () => {
  const pushHelp = runCli(["push", "--help"]);
  assert.equal(pushHelp.status, 0, pushHelp.stderr);
  assert.match(pushHelp.stdout, /--debug/);
  assert.match(pushHelp.stdout, /--dry-run-limit/);

  const pullHelp = runCli(["pull", "--help"]);
  assert.equal(pullHelp.status, 0, pullHelp.stderr);
  assert.match(pullHelp.stdout, /--debug/);
  assert.match(pullHelp.stdout, /--dry-run-limit/);
});

test("clean --ignored uses the ignored cleanup confirmation phrase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-clean-ignored-"));
  try {
    initWorkspace(root, "abc123", "Test Drive");
    const result = runCli(["clean", "--ignored", "--execute"], { cwd: root });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DELETE IGNORED GOOGLE DRIVE FILES/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restore --staged unstages paths like git restore --staged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-restore-staged-"));
  try {
    initWorkspace(root, "abc123", "Test Drive");
    writeIndex(root, {
      staged: [
        { action: "upload", path: "keep.md", localPath: "keep.md" },
        { action: "upload", path: "unstage.md", localPath: "unstage.md" },
      ],
    });

    const result = runCli(["restore", "--staged", "unstage.md"], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Unstaged: unstage\.md/);
    assert.deepEqual(
      readIndex(root).staged.map((entry) => entry.path),
      ["keep.md"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("log --oneline and show --stat render snapshot history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-log-show-"));
  try {
    initWorkspace(root, "abc123", "Test Drive");
    writeSnapshot(root, {
      timestamp: "2026-05-28T01:02:03.000Z",
      message: "sync docs",
      files: {
        "remote.md": { path: "remote.md", id: "file-1" },
      },
      localFiles: {
        "local.md": { md5: "abc" },
        "notes.md": { md5: "def" },
      },
    });

    const log = runCli(["log", "--oneline"], { cwd: root });
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /202605280102 sync docs/);

    const show = runCli(["show", "--stat", "HEAD"], { cwd: root });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /1 remote file\(s\), 2 local file\(s\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tag names snapshots and show resolves tag refs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-tag-"));
  try {
    initWorkspace(root, "abc123", "Test Drive");
    writeSnapshot(root, {
      timestamp: "2026-05-28T03:04:05.000Z",
      message: "taggable sync",
      files: {},
      localFiles: {},
    });

    const create = runCli(["tag", "v1", "HEAD"], { cwd: root });
    assert.equal(create.status, 0, create.stderr);
    assert.match(create.stdout, /Tagged 202605280304 as v1/);

    const list = runCli(["tag", "--list", "--verbose"], { cwd: root });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /v1\s+202605280304 taggable sync/);

    const show = runCli(["show", "--oneline", "v1"], { cwd: root });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /202605280304 taggable sync/);

    const del = runCli(["tag", "--delete", "v1"], { cwd: root });
    assert.equal(del.status, 0, del.stderr);
    assert.match(del.stdout, /Deleted tag 'v1'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rev-parse resolves HEAD, short refs, branches, and tags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-rev-parse-"));
  try {
    initWorkspace(root, "abc123", "Test Drive");
    writeSnapshot(root, {
      timestamp: "2026-05-28T06:07:08.000Z",
      message: "resolvable sync",
      files: {},
      localFiles: {},
    });

    const tag = runCli(["tag", "v1", "HEAD"], { cwd: root });
    assert.equal(tag.status, 0, tag.stderr);

    const branch = runCli(["branch", "feature", "HEAD"], { cwd: root });
    assert.equal(branch.status, 0, branch.stderr);

    const head = runCli(["rev-parse", "HEAD"], { cwd: root });
    assert.equal(head.status, 0, head.stderr);
    assert.match(head.stdout, /^202605280607\s*$/);

    const short = runCli(["rev-parse", "--short", "v1"], { cwd: root });
    assert.equal(short.status, 0, short.stderr);
    assert.match(short.stdout, /^2026052\s*$/);

    const branchRef = runCli(["rev-parse", "feature"], { cwd: root });
    assert.equal(branchRef.status, 0, branchRef.stderr);
    assert.match(branchRef.stdout, /^202605280607\s*$/);

    const abbrev = runCli(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    assert.equal(abbrev.status, 0, abbrev.stderr);
    assert.match(abbrev.stdout, /^main\s*$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("branch -v reports the linear Drive sync branch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-branch-"));
  try {
    initWorkspace(root, "abc123", "Test Drive");

    const branch = runCli(["branch", "-v"], { cwd: root });
    assert.equal(branch.status, 0, branch.stderr);
    assert.match(branch.stdout, /\* main \(no snapshot\) drive:\/\/abc123/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("branch refs can be created and switched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-branch-refs-"));
  try {
    initWorkspace(root, "abc123", "Test Drive");
    writeSnapshot(root, {
      timestamp: "2026-05-28T04:05:06.000Z",
      message: "branch base",
      files: {},
      localFiles: {},
    });

    const create = runCli(["branch", "feature", "HEAD"], { cwd: root });
    assert.equal(create.status, 0, create.stderr);
    assert.match(create.stdout, /Created branch feature at 202605280405/);

    const list = runCli(["branch", "-v"], { cwd: root });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /\* main/);
    assert.match(list.stdout, /feature 202605280405 drive:\/\/abc123/);

    const switched = runCli(["switch", "feature"], { cwd: root });
    assert.equal(switched.status, 0, switched.stderr);
    assert.match(switched.stdout, /Switched to branch 'feature'/);
    assert.match(switched.stdout, /Working files are unchanged/);

    const after = runCli(["branch"], { cwd: root });
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /\* feature/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkout supports branch switching and -b creation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-checkout-branch-"));
  try {
    initWorkspace(root, "abc123", "Test Drive");
    writeSnapshot(root, {
      timestamp: "2026-05-28T05:06:07.000Z",
      message: "checkout base",
      files: {},
      localFiles: {},
    });

    const create = runCli(["checkout", "-b", "topic"], { cwd: root });
    assert.equal(create.status, 0, create.stderr);
    assert.match(create.stdout, /Switched to branch 'topic'/);

    const main = runCli(["checkout", "main"], { cwd: root });
    assert.equal(main.status, 0, main.stderr);
    assert.match(main.stdout, /Switched to branch 'main'/);

    const topic = runCli(["checkout", "topic"], { cwd: root });
    assert.equal(topic.status, 0, topic.stderr);
    assert.match(topic.stdout, /Switched to branch 'topic'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
