import assert from "node:assert/strict";
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

  for (const entry of packageJson.files ?? []) {
    const normalizedEntry = entry.replace(/\/$/, "");
    try {
      await fs.access(path.join(root, normalizedEntry));
    } catch {
      missingEntries.push(entry);
    }
  }

  assert.deepEqual(missingEntries, []);
});
