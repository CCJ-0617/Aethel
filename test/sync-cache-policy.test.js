import test from "node:test";
import assert from "node:assert/strict";
import { remoteCacheEnabledByDefault } from "../src/core/sync-cache-policy.js";

test("status, add, and push use cached remote state by default", () => {
  for (const command of ["status", "add", "push"]) {
    assert.equal(remoteCacheEnabledByDefault(command), true, command);
  }
});

test("fetch and pull bypass cached remote state by default", () => {
  for (const command of ["fetch", "pull"]) {
    assert.equal(remoteCacheEnabledByDefault(command), false, command);
  }
});
