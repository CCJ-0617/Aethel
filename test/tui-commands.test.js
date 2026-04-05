import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandInput } from "../src/tui/commands.js";

test("parseCommandInput strips leading aethel", () => {
  assert.deepEqual(parseCommandInput("aethel status"), ["status"]);
});

test("parseCommandInput preserves quoted arguments", () => {
  assert.deepEqual(parseCommandInput("commit -m \"sync docs\""), [
    "commit",
    "-m",
    "sync docs",
  ]);
});

test("parseCommandInput rejects nested tui launch", () => {
  assert.throws(() => parseCommandInput("tui"), /Cannot launch `tui`/);
});

test("parseCommandInput rejects unterminated quotes", () => {
  assert.throws(() => parseCommandInput("show \"HEAD"), /Unterminated quote/);
});
