import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { initWorkspace, writeIndex } from "../src/core/config.js";
import {
  dedupeDuplicateFolders,
  ensureFolder,
  resetFolderLookupCache,
  syncLocalDirectoryToParent,
  uploadLocalEntry,
} from "../src/core/drive-api.js";
import { executeStaged } from "../src/core/sync.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

function folder(id, name, parentId, createdTime) {
  return {
    id,
    name,
    mimeType: FOLDER_MIME,
    parents: parentId ? [parentId] : [],
    createdTime,
    modifiedTime: createdTime,
    md5Checksum: null,
    size: null,
    capabilities: {
      canAddChildren: true,
      canEdit: true,
      canTrash: true,
      canDelete: true,
      canRename: true,
    },
    trashed: false,
  };
}

function file(id, name, parentId, createdTime, md5Checksum) {
  return {
    id,
    name,
    mimeType: "application/octet-stream",
    parents: [parentId],
    createdTime,
    modifiedTime: createdTime,
    md5Checksum,
    size: 1,
    capabilities: {
      canAddChildren: false,
      canEdit: true,
      canTrash: true,
      canDelete: true,
      canRename: true,
    },
    trashed: false,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeDrive(initialItems = [], { listDelayMs = 0 } = {}) {
  const items = new Map(initialItems.map((item) => [item.id, clone(item)]));
  let sequence = 0;
  let idCounter = 1000;
  const listQueries = [];

  function decodeQueryValue(value) {
    return value.replace(/\\\\/g, "\\").replace(/\\'/g, "'");
  }

  function matches(item, query) {
    if (!query) {
      return true;
    }

    return query.split(" and ").every((part) => {
      if (part === "trashed = false") {
        return !item.trashed;
      }

      const nameMatch = part.match(/^name = '(.+)'$/);
      if (nameMatch) {
        return item.name === decodeQueryValue(nameMatch[1]);
      }

      const mimeMatch = part.match(/^mimeType = '(.+)'$/);
      if (mimeMatch) {
        return item.mimeType === decodeQueryValue(mimeMatch[1]);
      }

      const parentMatch = part.match(/^'(.+)' in parents$/);
      if (parentMatch) {
        return (item.parents || []).includes(parentMatch[1]);
      }

      return true;
    });
  }

  async function drain(stream) {
    if (!stream) {
      return;
    }

    for await (const _ of stream) {
    }
  }

  function touch(item) {
    item.modifiedTime = new Date(1700000000000 + sequence++).toISOString();
  }

  return {
    files: {
      async list({ q, pageSize = 1000, pageToken, orderBy }) {
        if (listDelayMs) {
          await delay(listDelayMs);
        }

        listQueries.push(q || "");

        const matchesQuery = [...items.values()].filter((item) => matches(item, q));
        matchesQuery.sort((left, right) => {
          if (orderBy === "createdTime desc") {
            return Date.parse(right.createdTime) - Date.parse(left.createdTime);
          }
          return String(left.id).localeCompare(String(right.id));
        });

        const start = Number(pageToken || 0);
        const slice = matchesQuery.slice(start, start + pageSize).map(clone);
        const nextPageToken =
          start + pageSize < matchesQuery.length ? String(start + pageSize) : undefined;

        return {
          data: {
            files: slice,
            nextPageToken,
          },
        };
      },
      async create({ requestBody, media }) {
        await drain(media?.body);
        const id = `id-${++idCounter}`;
        const createdTime = new Date(1700000000000 + sequence++).toISOString();
        const item = {
          id,
          name: requestBody.name,
          mimeType: requestBody.mimeType || "application/octet-stream",
          parents: requestBody.parents || [],
          createdTime,
          modifiedTime: createdTime,
          md5Checksum: requestBody.mimeType === FOLDER_MIME ? null : `md5-${id}`,
          size: requestBody.mimeType === FOLDER_MIME ? null : 1,
          capabilities: {
            canAddChildren: true,
            canEdit: true,
            canTrash: true,
            canDelete: true,
            canRename: true,
          },
          trashed: false,
        };
        items.set(id, item);
        return { data: clone(item) };
      },
      async update({ fileId, requestBody = {}, addParents, removeParents, media }) {
        await drain(media?.body);
        const item = items.get(fileId);

        if (requestBody.name) {
          item.name = requestBody.name;
        }

        if (Object.hasOwn(requestBody, "trashed")) {
          item.trashed = Boolean(requestBody.trashed);
        }

        if (addParents || removeParents) {
          const nextParents = new Set(item.parents || []);
          for (const parentId of String(removeParents || "")
            .split(",")
            .filter(Boolean)) {
            nextParents.delete(parentId);
          }
          if (addParents) {
            nextParents.add(addParents);
          }
          item.parents = [...nextParents];
        }

        touch(item);
        return { data: clone(item) };
      },
      async delete({ fileId }) {
        items.delete(fileId);
        return { data: {} };
      },
      async get({ fileId }) {
        if (fileId === "root") {
          return {
            data: {
              id: "root",
              name: "My Drive",
              mimeType: FOLDER_MIME,
              parents: [],
              capabilities: {
                canAddChildren: true,
                canEdit: true,
              },
            },
          };
        }

        return { data: clone(items.get(fileId)) };
      },
    },
    snapshot() {
      return [...items.values()]
        .map(clone)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    },
    listQueries() {
      return [...listQueries];
    },
  };
}

function buildNestedDuplicateItems() {
  return [
    folder("top-a", "其他", "root", "2026-04-04T10:32:21.468Z"),
    folder("top-b", "其他", "root", "2026-04-04T10:32:21.495Z"),
    folder("docs-a", "docs", "top-a", "2026-04-04T10:33:00.000Z"),
    folder("docs-b", "docs", "top-b", "2026-04-04T10:33:05.000Z"),
    file("same-a", "same.txt", "docs-a", "2026-04-04T10:34:00.000Z", "same"),
    file("same-b", "same.txt", "docs-b", "2026-04-04T10:34:01.000Z", "same"),
    file("move-b", "move.txt", "docs-b", "2026-04-04T10:34:02.000Z", "move"),
    file("root-b", "root-only.txt", "top-b", "2026-04-04T10:34:03.000Z", "root"),
  ];
}

test.beforeEach(() => {
  resetFolderLookupCache();
});

test("ensureFolder creates one folder for concurrent callers", async () => {
  const drive = createFakeDrive([], { listDelayMs: 20 });
  const ids = await Promise.all(
    Array.from({ length: 8 }, () => ensureFolder(drive, "其他", null))
  );

  assert.equal(new Set(ids).size, 1);
  const folders = drive
    .snapshot()
    .filter(
      (item) =>
        item.mimeType === FOLDER_MIME &&
        !item.trashed &&
        item.name === "其他" &&
        item.parents.includes("root")
    );
  assert.equal(folders.length, 1);
});

test("ensureFolder reuses the canonical existing duplicate", async () => {
  const drive = createFakeDrive([
    folder("older", "其他", "root", "2026-04-04T10:32:21.468Z"),
    folder("newer", "其他", "root", "2026-04-04T10:32:21.493Z"),
    folder("newest", "其他", "root", "2026-04-04T10:32:21.495Z"),
  ]);

  const id = await ensureFolder(drive, "其他", null);

  assert.equal(id, "older");
  const folders = drive
    .snapshot()
    .filter((item) => item.mimeType === FOLDER_MIME && item.name === "其他");
  assert.equal(folders.length, 3);
});

test("dedupeDuplicateFolders dry-run reports duplicates without mutating", async () => {
  const drive = createFakeDrive(buildNestedDuplicateItems());
  const before = drive.snapshot();

  const result = await dedupeDuplicateFolders(drive, null, { execute: false });

  assert.equal(result.duplicateFolders.length, 1);
  assert.equal(result.remainingDuplicateFolders.length, 1);
  assert.deepEqual(drive.snapshot(), before);
});

test("dedupeDuplicateFolders merges nested folders and trashes empty losers", async () => {
  const drive = createFakeDrive(buildNestedDuplicateItems());

  const result = await dedupeDuplicateFolders(drive, null, { execute: true });

  assert.equal(result.movedItems, 2);
  assert.equal(result.trashedDuplicateFiles, 1);
  assert.equal(result.trashedFolders, 2);
  assert.equal(result.remainingDuplicateFolders.length, 0);

  const snapshot = drive.snapshot();
  const liveTopFolders = snapshot.filter(
    (item) =>
      item.mimeType === FOLDER_MIME &&
      !item.trashed &&
      item.name === "其他" &&
      item.parents.includes("root")
  );
  assert.equal(liveTopFolders.length, 1);

  const liveDocsFolders = snapshot.filter(
    (item) =>
      item.mimeType === FOLDER_MIME &&
      !item.trashed &&
      item.name === "docs" &&
      item.parents.includes("top-a")
  );
  assert.equal(liveDocsFolders.length, 1);

  const liveFiles = snapshot.filter((item) => !item.trashed && item.mimeType !== FOLDER_MIME);
  assert.equal(liveFiles.some((item) => item.name === "root-only.txt" && item.parents[0] === "top-a"), true);
  assert.equal(liveFiles.some((item) => item.name === "move.txt" && item.parents[0] === "docs-a"), true);
  assert.equal(snapshot.find((item) => item.id === "same-b").trashed, true);
  assert.equal(
    drive.listQueries().filter((query) => query === "trashed = false").length,
    2
  );
});

test("dedupeDuplicateFolders leaves conflicting duplicates in place", async () => {
  const drive = createFakeDrive([
    folder("top-a", "其他", "root", "2026-04-04T10:32:21.468Z"),
    folder("top-b", "其他", "root", "2026-04-04T10:32:21.495Z"),
    file("conflict-a", "conflict.txt", "top-a", "2026-04-04T10:34:00.000Z", "aaa"),
    file("conflict-b", "conflict.txt", "top-b", "2026-04-04T10:34:01.000Z", "bbb"),
  ]);

  const result = await dedupeDuplicateFolders(drive, null, { execute: true });

  assert.equal(result.skippedConflicts, 1);
  assert.equal(result.remainingDuplicateFolders.length, 1);
  assert.equal(drive.snapshot().find((item) => item.id === "top-b").trashed, false);
});

test("executeStaged does not create duplicate folders during concurrent uploads", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.mkdir(path.join(workspaceRoot, "其他", "docs"), { recursive: true });

    const staged = [];
    for (let index = 0; index < 6; index += 1) {
      const relativePath = `其他/docs/file-${index}.txt`;
      await fs.writeFile(path.join(workspaceRoot, relativePath), `file-${index}`);
      staged.push({
        action: "upload",
        path: relativePath,
        localPath: relativePath,
      });
    }

    writeIndex(workspaceRoot, { staged });

    const drive = createFakeDrive([], { listDelayMs: 20 });
    const result = await executeStaged(drive, workspaceRoot);

    assert.equal(result.uploaded, 6);

    const snapshot = drive.snapshot();
    const rootFolders = snapshot.filter(
      (item) =>
        item.mimeType === FOLDER_MIME &&
        !item.trashed &&
        item.name === "其他" &&
        item.parents.includes("root")
    );
    assert.equal(rootFolders.length, 1);

    const docsFolders = snapshot.filter(
      (item) =>
        item.mimeType === FOLDER_MIME &&
        !item.trashed &&
        item.name === "docs" &&
        item.parents.includes(rootFolders[0].id)
    );
    assert.equal(docsFolders.length, 1);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("uploadLocalEntry caches sibling lookups within the same target folder", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-upload-"));

  try {
    const bundlePath = path.join(workspaceRoot, "bundle");
    await fs.mkdir(bundlePath, { recursive: true });
    await Promise.all(
      ["a.txt", "b.txt", "c.txt"].map((name) =>
        fs.writeFile(path.join(bundlePath, name), name)
      )
    );

    const drive = createFakeDrive([]);
    const result = await uploadLocalEntry(drive, bundlePath, "root");

    assert.equal(result.uploadedFiles, 3);
    const bundleFolder = drive
      .snapshot()
      .find(
        (item) =>
          item.mimeType === FOLDER_MIME &&
          !item.trashed &&
          item.name === "bundle" &&
          item.parents.includes("root")
      );
    assert.ok(bundleFolder);

    const queries = drive.listQueries();
    assert.equal(
      queries.filter((query) => query === `'${bundleFolder.id}' in parents and trashed = false`).length,
      1
    );
    assert.equal(
      queries.filter((query) => query.includes(`'${bundleFolder.id}' in parents`) && query.includes("name =")).length,
      0
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("syncLocalDirectoryToParent skips paths ignored by .aethelignore", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-ignore-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.writeFile(path.join(workspaceRoot, ".aethelignore"), "venv/\n");
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "venv", "lib"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "keep.txt"), "keep");
    await fs.writeFile(path.join(workspaceRoot, "venv", "lib", "skip.txt"), "skip");

    const drive = createFakeDrive([]);
    const result = await syncLocalDirectoryToParent(drive, workspaceRoot, "root");

    assert.equal(result.uploadedFiles, 1);
    const liveItems = drive.snapshot().filter((item) => !item.trashed);
    assert.equal(liveItems.some((item) => item.name === "keep.txt"), true);
    assert.equal(liveItems.some((item) => item.name === "skip.txt"), false);
    assert.equal(
      liveItems.some((item) => item.mimeType === FOLDER_MIME && item.name === "venv"),
      false
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
