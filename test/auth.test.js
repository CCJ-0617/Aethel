import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAuthClient, resetAuth } from "../src/core/auth.js";

test("getAuthClient preserves missing-credentials errors", async () => {
  resetAuth();
  const missingCredentialsPath = path.join(
    os.tmpdir(),
    `aethel-missing-credentials-${process.pid}-${Date.now()}.json`
  );
  const tokenPath = path.join(
    os.tmpdir(),
    `aethel-token-${process.pid}-${Date.now()}.json`
  );

  await assert.rejects(
    getAuthClient(missingCredentialsPath, tokenPath),
    /OAuth credentials file was not found/
  );

  await assert.rejects(
    getAuthClient(missingCredentialsPath, tokenPath),
    /OAuth credentials file was not found/
  );
});
