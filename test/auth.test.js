import assert from "node:assert/strict";
import fs from "node:fs";
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
    /OAuth credentials file not found/
  );

  await assert.rejects(
    getAuthClient(missingCredentialsPath, tokenPath),
    /OAuth credentials file not found/
  );
});

test("auth command forces fresh OAuth instead of reusing cached token", () => {
  const cliSource = fs.readFileSync(
    path.resolve("src", "cli.js"),
    "utf8"
  );
  const repositorySource = fs.readFileSync(
    path.resolve("src", "core", "repository.js"),
    "utf8"
  );

  assert.match(cliSource, /handleAuth\(options\)[\s\S]*forceAuth: true/);
  assert.match(repositorySource, /authenticate\([\s\S]*force: Boolean\(this\._options\.forceAuth\)/);
});
