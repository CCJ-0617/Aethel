import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  initWorkspace,
  loadPackManifest,
  savePackConfig,
  savePackManifest,
  writeIndex,
} from "../src/core/config.js";
import { createManifest, setPack } from "../src/core/pack-manifest.js";
import { pushPack, pullPack } from "../src/core/pack-sync.js";
import { executeStaged } from "../src/core/sync.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

function md5(buffer) {
  return createHash("md5").update(buffer).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeDrive() {
  const items = new Map();
  const bodies = new Map();
  let idCounter = 1000;
  let sequence = 0;

  items.set("root", {
    id: "root",
    name: "My Drive",
    mimeType: FOLDER_MIME,
    parents: [],
    createdTime: "2026-04-26T00:00:00.000Z",
    modifiedTime: "2026-04-26T00:00:00.000Z",
    trashed: false,
  });

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

  function decodeQueryValue(value) {
    return value.replace(/\\\\/g, "\\").replace(/\\'/g, "'");
  }

  function matches(item, query) {
    if (!query) return true;
    return query.split(" and ").every((part) => {
      if (part === "trashed = false") return !item.trashed;

      const nameMatch = part.match(/^name = '(.+)'$/);
      if (nameMatch) return item.name === decodeQueryValue(nameMatch[1]);

      const mimeMatch = part.match(/^mimeType = '(.+)'$/);
      if (mimeMatch) return item.mimeType === decodeQueryValue(mimeMatch[1]);

      const parentMatch = part.match(/^'(.+)' in parents$/);
      if (parentMatch) return (item.parents || []).includes(parentMatch[1]);

      return true;
    });
  }

  function timestamp() {
    return new Date(Date.UTC(2026, 3, 26, 0, 0, sequence++)).toISOString();
  }

  return {
    files: {
      async list({ q, pageSize = 1000, pageToken }) {
        const matchesQuery = [...items.values()]
          .filter((item) => item.id !== "root")
          .filter((item) => matches(item, q))
          .sort((left, right) => String(left.id).localeCompare(String(right.id)));
        const start = Number(pageToken || 0);
        const slice = matchesQuery.slice(start, start + pageSize).map(clone);
        return {
          data: {
            files: slice,
            nextPageToken:
              start + pageSize < matchesQuery.length ? String(start + pageSize) : undefined,
          },
        };
      },
      async create({ requestBody, media }) {
        const body = await drain(media?.body);
        const id = `id-${++idCounter}`;
        const createdTime = timestamp();
        const isFolder = requestBody.mimeType === FOLDER_MIME;
        const item = {
          id,
          name: requestBody.name,
          mimeType: requestBody.mimeType || "application/octet-stream",
          parents: requestBody.parents || ["root"],
          createdTime,
          modifiedTime: createdTime,
          md5Checksum: isFolder ? null : md5(body),
          size: isFolder ? null : body.length,
          trashed: false,
        };
        items.set(id, item);
        bodies.set(id, body);
        return { data: clone(item) };
      },
      async update({ fileId, requestBody = {}, media }) {
        const item = items.get(fileId);
        if (!item) {
          const err = new Error(`File not found: ${fileId}`);
          err.code = 404;
          throw err;
        }
        const body = await drain(media?.body);
        if (requestBody.name) item.name = requestBody.name;
        if (Object.hasOwn(requestBody, "trashed")) item.trashed = Boolean(requestBody.trashed);
        if (body.length && item.mimeType !== FOLDER_MIME) {
          bodies.set(fileId, body);
          item.md5Checksum = md5(body);
          item.size = body.length;
        }
        item.modifiedTime = timestamp();
        return { data: clone(item) };
      },
      async get(params) {
        const item = items.get(params.fileId);
        if (params.alt === "media") {
          return { data: Readable.from(bodies.get(params.fileId) || Buffer.alloc(0)) };
        }
        return { data: clone(item) };
      },
    },
    snapshot() {
      return [...items.values()].filter((item) => item.id !== "root").map(clone);
    },
    corruptBody(fileId, content = "not a valid pack") {
      bodies.set(fileId, Buffer.from(content));
    },
  };
}

async function createWorkspace() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-sync-test-"));
  const root = path.join(tempDir, "workspace");
  await fs.mkdir(path.join(root, "vendor", "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "vendor", "pkg", "index.js"), "module.exports = 1;");
  initWorkspace(root, null, "My Drive");
  savePackConfig(root, {
    packing: {
      enabled: true,
      compression: { default: { algorithm: "gzip", level: 6 } },
      rules: [{ path: "vendor", strategy: "full" }],
    },
  });
  return { tempDir, root };
}

test("pushPack uploads archive and pullPack restores directory contents", async () => {
  const { tempDir, root } = await createWorkspace();

  try {
    const drive = createFakeDrive();
    const pushed = await pushPack(drive, root, "vendor");
    const manifest = loadPackManifest(root);

    assert.equal(manifest.packs.vendor.remoteFileId, pushed.remoteFileId);
    assert.ok(manifest.packs.vendor.archivePath.startsWith(".aethel/packs/"));
    assert.ok(drive.snapshot().some((item) => item.id === pushed.remoteFileId));

    await fs.rm(path.join(root, "vendor"), { recursive: true, force: true });
    await fs.mkdir(path.join(root, "vendor"), { recursive: true });
    await fs.writeFile(path.join(root, "vendor", "junk.txt"), "local junk");

    const pulled = await pullPack(drive, root, "vendor");
    assert.equal(pulled.fileCount, 1);
    assert.equal(
      await fs.readFile(path.join(root, "vendor", "pkg", "index.js"), "utf-8"),
      "module.exports = 1;"
    );
    await assert.rejects(
      () => fs.access(path.join(root, "vendor", "junk.txt")),
      /ENOENT/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("pullPack leaves existing directory untouched when download verification fails", async () => {
  const { tempDir, root } = await createWorkspace();

  try {
    const drive = createFakeDrive();
    const pushed = await pushPack(drive, root, "vendor");
    await fs.writeFile(path.join(root, "vendor", "local-only.txt"), "keep me");

    drive.corruptBody(pushed.remoteFileId);

    await assert.rejects(
      () => pullPack(drive, root, "vendor"),
      /Integrity check failed/
    );
    assert.equal(
      await fs.readFile(path.join(root, "vendor", "local-only.txt"), "utf-8"),
      "keep me"
    );
    assert.equal(
      await fs.readFile(path.join(root, "vendor", "pkg", "index.js"), "utf-8"),
      "module.exports = 1;"
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("pushPack recreates archive when legacy remote file id is missing", async () => {
  const { tempDir, root } = await createWorkspace();

  try {
    const drive = createFakeDrive();
    const manifest = createManifest();
    setPack(manifest, "vendor", {
      packId: "pack-vendor-legacy",
      remoteFileId: "deleted-remote-file",
      localTreeHash: "sha256:old",
      remoteTreeHash: "sha256:old",
    });
    savePackManifest(root, manifest);

    const result = await pushPack(drive, root, "vendor");
    const nextManifest = loadPackManifest(root);

    assert.notEqual(result.remoteFileId, "deleted-remote-file");
    assert.equal(nextManifest.packs.vendor.remoteFileId, result.remoteFileId);
    assert.ok(drive.snapshot().some((item) => item.id === result.remoteFileId));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("executeStaged handles push_pack entries", async () => {
  const { tempDir, root } = await createWorkspace();

  try {
    const drive = createFakeDrive();
    writeIndex(root, { staged: [{ action: "push_pack", path: "vendor" }] });

    const result = await executeStaged(drive, root);
    const manifest = loadPackManifest(root);

    assert.equal(result.packsPushed, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(manifest.packs.vendor.localTreeHash, manifest.packs.vendor.remoteTreeHash);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
