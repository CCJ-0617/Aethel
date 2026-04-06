import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("demo script runs end-to-end", () => {
  const result = spawnSync(process.execPath, ["scripts/demo.js", "--cleanup"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Aethel demo/);
  assert.match(result.stdout, /\$ aethel add --all/);
  assert.match(result.stdout, /Commit complete: 2 downloaded, 2 uploaded/);
  assert.match(result.stdout, /Everything up to date\./);
});

test("demo script supports redacted workspace output", () => {
  const result = spawnSync(process.execPath, ["scripts/demo.js", "--cleanup", "--redact-workspace"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Workspace: \/tmp\/aethel-demo-XXXXXX/);
  assert.doesNotMatch(result.stdout, /\/var\/folders\//);
});
