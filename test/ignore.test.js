import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultIgnoreFile, loadIgnoreRules } from "../src/core/ignore.js";

test("default ignore template covers common Python virtual environment names", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-default-ignore-"));

  try {
    assert.equal(createDefaultIgnoreFile(root), true);
    const rules = loadIgnoreRules(root);

    for (const virtualEnvironment of [
      ".venv",
      ".venv-backend",
      ".venv_backend",
      "venv",
      "venv-py313",
      "venv_py313",
      "env",
      "env-local",
      "env_local",
      "ENV",
      "ENV-local",
      "ENV_local",
      "uv-cache",
    ]) {
      assert.equal(rules.ignores(`apps/api/${virtualEnvironment}`), true);
      assert.equal(rules.ignores(`apps/api/${virtualEnvironment}/bin/python`), true);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
