import test from "node:test";
import assert from "node:assert/strict";
import { summarizeChanges } from "../src/core/change-summary.js";

function change(path, shortStatus = "ML", description = "modified locally") {
  return { path, shortStatus, description };
}

test("summarizeChanges collapses multiple changes with the same parent folder", () => {
  const entries = summarizeChanges([
    change("docs/a.md"),
    change("docs/b.md"),
    change("notes/today.md"),
  ]);

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => ({
      kind: entry.kind,
      path: entry.path,
      shortStatus: entry.shortStatus,
      description: entry.description,
      count: entry.count,
    })),
    [
      {
        kind: "group",
        path: "docs/",
        shortStatus: "ML",
        description: "2 changes: modified locally",
        count: 2,
      },
      {
        kind: "change",
        path: "notes/today.md",
        shortStatus: "ML",
        description: "modified locally",
        count: 1,
      },
    ]
  );
});

test("summarizeChanges keeps root-level changes explicit", () => {
  const entries = summarizeChanges([
    change("a.md"),
    change("b.md"),
  ]);

  assert.deepEqual(entries.map((entry) => entry.path), ["a.md", "b.md"]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["change", "change"]);
});

test("summarizeChanges marks grouped mixed change statuses", () => {
  const entries = summarizeChanges([
    change("docs/old.md", "-L", "deleted locally"),
    change("docs/new.md", "+L", "new locally"),
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "docs/");
  assert.equal(entries[0].shortStatus, "..");
  assert.equal(entries[0].description, "2 changes");
});

test("summarizeChanges detail mode returns every file-level change", () => {
  const entries = summarizeChanges([
    change("docs/a.md"),
    change("docs/b.md"),
  ], { detail: true });

  assert.deepEqual(entries.map((entry) => entry.path), ["docs/a.md", "docs/b.md"]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["change", "change"]);
});
