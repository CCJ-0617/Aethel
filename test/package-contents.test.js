import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package files entries exist before npm packing", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8")
  );

  const missingEntries = [];
  const ignoredEntries = [];

  for (const entry of packageJson.files ?? []) {
    const normalizedEntry = entry.replace(/\/$/, "");
    try {
      await fs.access(path.join(root, normalizedEntry));
    } catch {
      missingEntries.push(entry);
    }

    const ignored = spawnSync(
      "git",
      ["check-ignore", "--quiet", normalizedEntry],
      { cwd: root }
    );
    if (ignored.status === 0) {
      ignoredEntries.push(entry);
    }
  }

  assert.deepEqual(missingEntries, []);
  assert.deepEqual(ignoredEntries, []);
});

test("package exposes stable and beta CLI command aliases", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8")
  );

  assert.equal(packageJson.bin?.aethel, "src/cli.js");
  assert.equal(packageJson.bin?.aethel_beta, "src/cli.js");
});
