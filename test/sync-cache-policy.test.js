import test from "node:test";
import assert from "node:assert/strict";
import { remoteCacheEnabledByDefault } from "../src/core/sync-cache-policy.js";

test("status, add, pull, and push use cached remote state by default", () => {
  for (const command of ["status", "add", "pull", "push"]) {
    assert.equal(remoteCacheEnabledByDefault(command), true, command);
  }
});

test("fetch bypasses cached remote state by default", () => {
  assert.equal(remoteCacheEnabledByDefault("fetch"), false);
});
