#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { initWorkspace } from "../src/core/config.js";
import { ensureFolder, resetFolderLookupCache } from "../src/core/drive-api.js";
import { Repository } from "../src/core/repository.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

function md5(buffer) {
  return createHash("md5").update(buffer).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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
    trashed: false,
  };
}

function file(id, name, parentId, createdTime, content) {
  const body = Buffer.from(content);
  return {
    id,
    name,
    mimeType: "application/octet-stream",
    parents: [parentId],
    createdTime,
    modifiedTime: createdTime,
    md5Checksum: md5(body),
    size: body.length,
    trashed: false,
    body,
  };
}

function createFakeDrive(initialItems = []) {
  const items = new Map();
  const contentById = new Map();
  let sequence = 0;
  let idCounter = 1000;

  for (const item of initialItems) {
    const next = clone(item);
    delete next.body;
    items.set(next.id, next);
    if (item.body) {
      contentById.set(next.id, Buffer.from(item.body));
    }
  }

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
      return Buffer.alloc(0);
    }

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  function touch(item) {
    item.modifiedTime = new Date(1710000000000 + sequence++).toISOString();
  }

  return {
    files: {
      async list({ q, pageSize = 1000, pageToken, orderBy }) {
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
        const body = await drain(media?.body);
        const id = `id-${++idCounter}`;
        const createdTime = new Date(1710000000000 + sequence++).toISOString();
        const item = {
          id,
          name: requestBody.name,
          mimeType: requestBody.mimeType || "application/octet-stream",
          parents: requestBody.parents || [],
          createdTime,
          modifiedTime: createdTime,
          md5Checksum: requestBody.mimeType === FOLDER_MIME ? null : md5(body),
          size: requestBody.mimeType === FOLDER_MIME ? null : body.length,
          trashed: false,
        };
        items.set(id, item);
        if (item.mimeType !== FOLDER_MIME) {
          contentById.set(id, body);
        }
        return { data: clone(item) };
      },
      async update({ fileId, requestBody = {}, addParents, removeParents, media }) {
        const body = await drain(media?.body);
        const item = items.get(fileId);

        if (!item) {
          throw new Error(`Missing file: ${fileId}`);
        }

        if (requestBody.name) {
          item.name = requestBody.name;
        }

        if (Object.hasOwn(requestBody, "trashed")) {
          item.trashed = Boolean(requestBody.trashed);
        }

        if (addParents || removeParents) {
          const nextParents = new Set(item.parents || []);
          for (const parentId of String(removeParents || "").split(",").filter(Boolean)) {
            nextParents.delete(parentId);
          }
          if (addParents) {
            nextParents.add(addParents);
          }
          item.parents = [...nextParents];
        }

        if (body.length && item.mimeType !== FOLDER_MIME) {
          item.md5Checksum = md5(body);
          item.size = body.length;
          contentById.set(fileId, body);
        }

        touch(item);
        return { data: clone(item) };
      },
      async delete({ fileId }) {
        items.delete(fileId);
        contentById.delete(fileId);
        return { data: {} };
      },
      async get({ fileId, alt }) {
        if (fileId === "root") {
          return {
            data: {
              id: "root",
              name: "My Drive",
              mimeType: FOLDER_MIME,
              parents: [],
              createdTime: "2026-01-01T00:00:00.000Z",
            },
          };
        }

        const item = items.get(fileId);
        if (!item) {
          throw new Error(`Missing file: ${fileId}`);
        }

        if (alt === "media") {
          return {
            data: Readable.from([contentById.get(fileId) || Buffer.alloc(0)]),
          };
        }

        return { data: clone(item) };
      },
    },
  };
}

function writeLocal(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function formatStatus(diff, staged) {
  const lines = [];

  if (diff.isClean && staged.length === 0) {
    lines.push("Everything up to date.");
    return lines;
  }

  if (staged.length) {
    lines.push(`Staged changes (${staged.length}):`);
    for (const entry of staged) {
      lines.push(`  ${entry.action.padStart(15, " ")}  ${entry.path}`);
    }
  }

  const stagedPaths = new Set(staged.map((e) => e.path));
  const unstagedRemote = diff.remoteChanges.filter((c) => !stagedPaths.has(c.path));
  const unstagedLocal = diff.localChanges.filter((c) => !stagedPaths.has(c.path));
  const unstagedConflicts = diff.conflicts.filter((c) => !stagedPaths.has(c.path));

  if (unstagedRemote.length) {
    lines.push(`Remote changes (${unstagedRemote.length}):`);
    for (const change of unstagedRemote) {
      lines.push(`  ${change.shortStatus} ${change.path}  (${change.description})`);
    }
  }

  if (unstagedLocal.length) {
    lines.push(`Local changes (${unstagedLocal.length}):`);
    for (const change of unstagedLocal) {
      lines.push(`  ${change.shortStatus} ${change.path}  (${change.description})`);
    }
  }

  if (unstagedConflicts.length) {
    lines.push(`Conflicts (${unstagedConflicts.length}):`);
    for (const change of unstagedConflicts) {
      lines.push(`  ${change.shortStatus} ${change.path}  (${change.description})`);
    }
  }

  return lines;
}

function formatDiff(diff) {
  if (diff.isClean) {
    return ["No changes detected."];
  }

  const lines = [];
  const sections = [
    ["Remote changes", diff.remoteChanges],
    ["Local changes", diff.localChanges],
    ["Conflicts", diff.conflicts],
  ];

  for (const [title, changes] of sections) {
    if (!changes.length) {
      continue;
    }

    lines.push(`${title}:`);
    for (const change of changes) {
      lines.push(`  ${change.shortStatus} ${change.path}`);
      lines.push(`       ${change.description}`);
    }
  }

  return lines;
}

async function commit(repo, message, snapshotHint) {
  const result = await repo.executeStaged();
  await repo.saveSnapshot(message, snapshotHint);
  return result.summary;
}

function renderCommand(lines, command, output) {
  if (lines.length) {
    lines.push("");
  }

  lines.push(`$ ${command}`);
  lines.push(...output);
}

export async function generateDemoTranscript({ redactWorkspace = false } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-demo-"));
  const visibleWorkspace = redactWorkspace ? "/tmp/aethel-demo-XXXXXX" : workspace;
  resetFolderLookupCache();

  try {
    initWorkspace(workspace, "root", "My Drive");

    const drive = createFakeDrive([
      folder("fld-docs", "docs", "root", "2026-04-01T10:00:00.000Z"),
      folder("fld-notes", "notes", "root", "2026-04-01T10:01:00.000Z"),
      file("file-spec", "spec.txt", "fld-docs", "2026-04-01T10:02:00.000Z", "Spec v1\n"),
      file("file-ideas", "ideas.txt", "fld-notes", "2026-04-01T10:03:00.000Z", "Idea v1\n"),
    ]);

    const repo = new Repository(workspace, { drive });

    writeLocal(workspace, "docs/spec.txt", "Spec v1\n");
    writeLocal(workspace, "notes/ideas.txt", "Idea v1\n");
    await repo.saveSnapshot("initial sync");

    await drive.files.update({
      fileId: "file-spec",
      media: { body: Readable.from(["Spec v2 from Drive\n"]) },
    });
    const designFolderId = await ensureFolder(drive, "design");
    await drive.files.create({
      requestBody: {
        name: "roadmap.txt",
        parents: [designFolderId],
      },
      media: { body: Readable.from(["Roadmap from Drive\n"]) },
    });
    writeLocal(workspace, "notes/ideas.txt", "Idea v2 from local\n");
    writeLocal(workspace, "drafts/todo.txt", "Local draft\n");
    repo.invalidateRemoteCache();

    const lines = [
      "Aethel demo",
      `Workspace: ${visibleWorkspace}`,
      "Backend: fake Google Drive",
      "",
      "Scenario:",
      "  Drive changed docs/spec.txt and added design/roadmap.txt",
      "  Local changed notes/ideas.txt and added drafts/todo.txt",
    ];

    let state = await repo.loadState({ useCache: false });

    renderCommand(lines, "aethel status", formatStatus(state.diff, repo.getStagedEntries()));
    renderCommand(lines, "aethel diff --side all", formatDiff(state.diff));

    const stagedCount = repo.stageChanges(
      state.diff.changes.filter((change) => change.suggestedAction !== "conflict")
    );
    renderCommand(lines, "aethel add --all", [`Staged ${stagedCount} change(s).`]);
    renderCommand(lines, "aethel status", formatStatus(state.diff, repo.getStagedEntries()));

    const summary = await commit(repo, "demo sync");
    renderCommand(lines, 'aethel commit -m "demo sync"', [`Commit complete: ${summary}`]);

    state = await repo.loadState({ useCache: false });
    renderCommand(lines, "aethel status", formatStatus(state.diff, repo.getStagedEntries()));

    lines.push("");
    lines.push(`Inspect the demo workspace at: ${visibleWorkspace}`);

    return { workspace, lines };
  } finally {
    resetFolderLookupCache();
  }
}

export async function runDemo({ cleanup = false, redactWorkspace = false } = {}) {
  const { workspace, lines } = await generateDemoTranscript({ redactWorkspace });
  process.stdout.write(`${lines.join("\n")}\n`);

  if (cleanup) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const entryPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === entryPath) {
  const cleanup = process.argv.includes("--cleanup");
  const redactWorkspace = process.argv.includes("--redact-workspace");

  runDemo({ cleanup, redactWorkspace }).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
