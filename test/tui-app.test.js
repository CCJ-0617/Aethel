import test from "node:test";
import assert from "node:assert/strict";

// The helper functions in app.js are not exported, so we replicate them here
// to test the logic independently. If they are ever extracted into a utility
// module these tests can import directly.

function truncate(value, width) {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

function scrollWindow(length, cursor, height) {
  return Math.min(
    Math.max(cursor - Math.floor(height / 2), 0),
    Math.max(length - height, 0)
  );
}

// ── truncate ──

test("truncate returns the original string when it fits", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello", 5), "hello");
});

test("truncate adds ellipsis when string exceeds width", () => {
  assert.equal(truncate("hello world", 5), "hell…");
  assert.equal(truncate("abcdef", 4), "abc…");
});

test("truncate handles width of 1", () => {
  assert.equal(truncate("hello", 1), "h");
});

test("truncate handles width of 0", () => {
  assert.equal(truncate("hello", 0), "");
});

test("truncate handles empty string", () => {
  assert.equal(truncate("", 5), "");
  assert.equal(truncate("", 0), "");
});

test("truncate with width equal to string length returns the string", () => {
  assert.equal(truncate("abc", 3), "abc");
});

test("truncate with width of 2 keeps one char plus ellipsis", () => {
  assert.equal(truncate("hello", 2), "h…");
});

// ── scrollWindow ──

test("scrollWindow returns 0 when all items fit", () => {
  assert.equal(scrollWindow(5, 0, 10), 0);
  assert.equal(scrollWindow(5, 4, 10), 0);
});

test("scrollWindow centers cursor in the viewport", () => {
  // 20 items, cursor at 10, viewport of 6 → offset = 10 - 3 = 7
  assert.equal(scrollWindow(20, 10, 6), 7);
});

test("scrollWindow clamps to 0 when cursor is near the top", () => {
  assert.equal(scrollWindow(20, 1, 6), 0);
  assert.equal(scrollWindow(20, 0, 6), 0);
});

test("scrollWindow clamps to max offset when cursor is near the bottom", () => {
  // 20 items, viewport 6 → max offset = 14
  assert.equal(scrollWindow(20, 19, 6), 14);
  assert.equal(scrollWindow(20, 18, 6), 14);
});

test("scrollWindow with cursor exactly at midpoint", () => {
  // 10 items, cursor at 3, viewport of 6 → offset = 3 - 3 = 0
  assert.equal(scrollWindow(10, 3, 6), 0);
  // 10 items, cursor at 5, viewport of 6 → offset = 5 - 3 = 2
  assert.equal(scrollWindow(10, 5, 6), 2);
});

test("scrollWindow with single item", () => {
  assert.equal(scrollWindow(1, 0, 6), 0);
});

test("scrollWindow with viewport of 1", () => {
  // 5 items, cursor 3, viewport 1 → offset = min(max(3 - 0, 0), max(4, 0)) = min(3, 4) = 3
  assert.equal(scrollWindow(5, 3, 1), 3);
});

test("scrollWindow with 0 items", () => {
  assert.equal(scrollWindow(0, 0, 6), 0);
});

// ── parseCommandInput (imported) ──

import { parseCommandInput } from "../src/tui/commands.js";

test("parseCommandInput returns empty array for empty input", () => {
  assert.deepEqual(parseCommandInput(""), []);
  assert.deepEqual(parseCommandInput("   "), []);
});

test("parseCommandInput strips aethel prefix", () => {
  assert.deepEqual(parseCommandInput("aethel status"), ["status"]);
  assert.deepEqual(parseCommandInput("aethel diff --side all"), [
    "diff",
    "--side",
    "all",
  ]);
});

test("parseCommandInput works without aethel prefix", () => {
  assert.deepEqual(parseCommandInput("status"), ["status"]);
  assert.deepEqual(parseCommandInput("commit -m sync"), [
    "commit",
    "-m",
    "sync",
  ]);
});

test("parseCommandInput preserves single-quoted arguments", () => {
  assert.deepEqual(parseCommandInput("commit -m 'my message'"), [
    "commit",
    "-m",
    "my message",
  ]);
});

test("parseCommandInput preserves double-quoted arguments", () => {
  assert.deepEqual(parseCommandInput('commit -m "my message"'), [
    "commit",
    "-m",
    "my message",
  ]);
});

test("parseCommandInput handles escaped characters", () => {
  assert.deepEqual(parseCommandInput("commit -m hello\\ world"), [
    "commit",
    "-m",
    "hello world",
  ]);
});

test("parseCommandInput handles backslash at end of input", () => {
  assert.deepEqual(parseCommandInput("status\\"), ["status\\"]);
});

test("parseCommandInput rejects tui command", () => {
  assert.throws(() => parseCommandInput("tui"), /Cannot launch `tui`/);
  assert.throws(() => parseCommandInput("aethel tui"), /Cannot launch `tui`/);
});

test("parseCommandInput rejects unterminated single quote", () => {
  assert.throws(() => parseCommandInput("commit -m 'oops"), /Unterminated quote/);
});

test("parseCommandInput rejects unterminated double quote", () => {
  assert.throws(
    () => parseCommandInput('commit -m "oops'),
    /Unterminated quote/
  );
});

test("parseCommandInput handles multiple spaces between tokens", () => {
  assert.deepEqual(parseCommandInput("status    --verbose"), [
    "status",
    "--verbose",
  ]);
});

test("parseCommandInput handles aethel as the only token", () => {
  assert.deepEqual(parseCommandInput("aethel"), []);
});

// ── COMMAND_CATALOG (imported) ──

import { COMMAND_CATALOG } from "../src/tui/command-catalog.js";

test("COMMAND_CATALOG has no duplicate names", () => {
  const names = COMMAND_CATALOG.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
});

test("every catalog entry has name, description, and template", () => {
  for (const entry of COMMAND_CATALOG) {
    assert.ok(entry.name, `entry missing name`);
    assert.ok(entry.description, `${entry.name} missing description`);
    assert.ok(entry.template, `${entry.name} missing template`);
  }
});

test("no catalog entry has tui as a command", () => {
  for (const entry of COMMAND_CATALOG) {
    assert.notEqual(
      entry.name,
      "tui",
      "tui should not appear in the command catalog"
    );
    assert.ok(
      !entry.template.startsWith("tui"),
      `${entry.name} template should not launch tui`
    );
  }
});

test("catalog templates are valid parseCommandInput inputs", () => {
  for (const entry of COMMAND_CATALOG) {
    assert.doesNotThrow(
      () => parseCommandInput(entry.template),
      `template for ${entry.name} should be parseable`
    );
  }
});

test("catalog template first token matches the entry name", () => {
  for (const entry of COMMAND_CATALOG) {
    const tokens = parseCommandInput(entry.template);
    assert.ok(tokens.length > 0, `${entry.name} template produces no tokens`);
    assert.equal(
      tokens[0],
      entry.name,
      `${entry.name} template should start with its own name`
    );
  }
});
