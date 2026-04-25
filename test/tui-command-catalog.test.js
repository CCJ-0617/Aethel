import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_CATALOG } from "../src/tui/command-catalog.js";

test("COMMAND_CATALOG exposes every non-TUI CLI command", () => {
  assert.deepEqual(
    COMMAND_CATALOG.map((entry) => entry.name),
    [
      "auth",
      "clean",
      "init",
      "status",
      "diff",
      "add",
      "reset",
      "commit",
      "log",
      "fetch",
      "dedupe-folders",
      "pull",
      "push",
      "resolve",
      "ignore",
      "show",
      "restore",
      "rm",
      "mv",
      "verify",
    ]
  );
});

test("COMMAND_CATALOG provides TUI actions or a custom template for every command", () => {
  for (const entry of COMMAND_CATALOG) {
    assert.ok(typeof entry.template === "string" && entry.template.length > 0);
    assert.ok(Array.isArray(entry.actions));
  }
});
