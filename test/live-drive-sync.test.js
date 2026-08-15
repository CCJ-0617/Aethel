import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { authenticate } from "../src/core/auth.js";
import { initWorkspace, readIndex, writeSnapshot } from "../src/core/config.js";
import {
  ensureFolder,
  getRemoteState,
  resetFolderLookupCache,
  withDriveRetry,
} from "../src/core/drive-api.js";
import { computeDiff } from "../src/core/diff.js";
import { scanLocal, buildSnapshot } from "../src/core/snapshot.js";
import { stageChanges } from "../src/core/staging.js";
import { executeStaged } from "../src/core/sync.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const LIVE_FOLDER_NAME =
  process.env.AETHEL_LIVE_DRIVE_FOLDER ||
  "aethel-codex-remote-delete-test-20260620-222314";
const LIVE_RUN_FOLDER_NAME =
  process.env.AETHEL_LIVE_DRIVE_RUN_FOLDER || "codex-live-sync-matrix";
const NESTED_RENAME_RUN_FOLDER_NAME =
  process.env.AETHEL_LIVE_DRIVE_NESTED_RENAME_RUN_FOLDER ||
  `${LIVE_RUN_FOLDER_NAME}-nested-renames`;
const RENAME_DELETE_RUN_FOLDER_NAME =
  process.env.AETHEL_LIVE_DRIVE_RENAME_DELETE_RUN_FOLDER ||
  `${LIVE_RUN_FOLDER_NAME}-rename-delete-conflicts`;
const LIVE_TEST_ENABLED = process.env.AETHEL_LIVE_DRIVE_TEST === "1";

const KNOWN_TEST_NAMES = new Set([
  "remote-delete-file.txt",
  "remote-delete-dir",
  "remote-added-file.txt",
  "remote-added-dir",
  "local-delete-file.txt",
  "local-delete-dir",
  "local-added-file.txt",
  "local-added-dir",
  "local-rename-file-old.txt",
  "local-rename-file-new.txt",
  "local-rename-dir-old",
  "local-rename-dir-new",
  "remote-rename-file-old.txt",
  "remote-rename-file-new.txt",
  "remote-rename-dir-old",
  "remote-rename-dir-new",
]);

const NESTED_RENAME_TEST_NAMES = new Set([
  "remote-parent-old",
  "remote-parent-new",
  "remote-subtree",
  "local-parent-old",
  "local-parent-new",
  "local-subtree",
]);

const RENAME_DELETE_TEST_NAMES = new Set([
  "local-rename-remote-delete-old.txt",
  "local-rename-remote-delete-new.txt",
  "remote-rename-local-delete-old.txt",
  "remote-rename-local-delete-new.txt",
]);

async function listDirectChildren(drive, parentId) {
  const files = [];
  let pageToken = null;

  do {
    const response = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: 1000,
      pageToken,
    });
    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken || null;
  } while (pageToken);

  return files;
}

async function resetKnownChildren(drive, folderId, knownTestNames = KNOWN_TEST_NAMES) {
  const children = await listDirectChildren(drive, folderId);
  const unexpected = children.filter((item) => !knownTestNames.has(item.name));
  assert.deepEqual(
    unexpected.map((item) => item.name).sort(),
    [],
    `Refusing to reset ${LIVE_FOLDER_NAME}/${LIVE_RUN_FOLDER_NAME}; it contains non-test entries`
  );

  await Promise.all(
    children.map((item) =>
      drive.files.update({
        fileId: item.id,
        requestBody: { trashed: true },
        fields: "id,trashed",
      })
    )
  );
}

async function createRemoteFolder(drive, parentId, name) {
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    },
    fields: "id,name,mimeType,parents,createdTime,modifiedTime",
  });
  return response.data;
}

async function createRemoteFile(drive, parentId, name, content) {
  const response = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
    },
    media: {
      mimeType: "text/plain",
      body: Readable.from([content]),
    },
    fields: "id,name,mimeType,parents,createdTime,modifiedTime,md5Checksum,size",
  });
  return response.data;
}

async function writeLocalFile(root, relativePath, content) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

function changeActions(diff) {
  return Object.fromEntries(
    diff.changes
      .map((change) => [change.path, change.suggestedAction])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

test(
  "live Google Drive sync handles add, delete, and rename on files and folders",
  {
    skip: LIVE_TEST_ENABLED
      ? false
      : "Set AETHEL_LIVE_DRIVE_TEST=1 to run against real Google Drive",
  },
  async () => {
    resetFolderLookupCache();

    const drive = withDriveRetry(await authenticate());
    const parentFolderId = await ensureFolder(drive, LIVE_FOLDER_NAME, null);
    const folderId = await ensureFolder(drive, LIVE_RUN_FOLDER_NAME, parentFolderId);
    await resetKnownChildren(drive, folderId);

    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "aethel-live-drive-sync-")
    );

    try {
      initWorkspace(
        workspaceRoot,
        folderId,
        `${LIVE_FOLDER_NAME}/${LIVE_RUN_FOLDER_NAME}`
      );

      const remoteDeleteFile = await createRemoteFile(
        drive,
        folderId,
        "remote-delete-file.txt",
        "remote delete file baseline\n"
      );
      const remoteDeleteDir = await createRemoteFolder(
        drive,
        folderId,
        "remote-delete-dir"
      );
      await createRemoteFile(
        drive,
        folderId,
        "local-delete-file.txt",
        "local delete file baseline\n"
      );
      await createRemoteFolder(
        drive,
        folderId,
        "local-delete-dir"
      );
      await createRemoteFile(
        drive,
        folderId,
        "local-rename-file-old.txt",
        "local rename file baseline\n"
      );
      await createRemoteFolder(
        drive,
        folderId,
        "local-rename-dir-old"
      );
      const remoteRenameFile = await createRemoteFile(
        drive,
        folderId,
        "remote-rename-file-old.txt",
        "remote rename file baseline\n"
      );
      const remoteRenameDir = await createRemoteFolder(
        drive,
        folderId,
        "remote-rename-dir-old"
      );

      await writeLocalFile(
        workspaceRoot,
        "remote-delete-file.txt",
        "remote delete file baseline\n"
      );
      await fs.mkdir(path.join(workspaceRoot, "remote-delete-dir"));
      await writeLocalFile(
        workspaceRoot,
        "local-delete-file.txt",
        "local delete file baseline\n"
      );
      await fs.mkdir(path.join(workspaceRoot, "local-delete-dir"));
      await writeLocalFile(
        workspaceRoot,
        "local-rename-file-old.txt",
        "local rename file baseline\n"
      );
      await fs.mkdir(path.join(workspaceRoot, "local-rename-dir-old"));
      await writeLocalFile(
        workspaceRoot,
        "remote-rename-file-old.txt",
        "remote rename file baseline\n"
      );
      await fs.mkdir(path.join(workspaceRoot, "remote-rename-dir-old"));

      const baselineRemote = await getRemoteState(drive, folderId);
      const baselineLocal = await scanLocal(workspaceRoot);
      const baselineSnapshot = buildSnapshot(
        baselineRemote.files,
        baselineLocal,
        "live Google Drive baseline"
      );
      writeSnapshot(workspaceRoot, baselineSnapshot);

      await Promise.all([
        drive.files.update({
          fileId: remoteDeleteFile.id,
          requestBody: { trashed: true },
          fields: "id,trashed",
        }),
        drive.files.update({
          fileId: remoteDeleteDir.id,
          requestBody: { trashed: true },
          fields: "id,trashed",
        }),
        createRemoteFile(
          drive,
          folderId,
          "remote-added-file.txt",
          "remote added file\n"
        ),
        createRemoteFolder(drive, folderId, "remote-added-dir"),
        drive.files.update({
          fileId: remoteRenameFile.id,
          requestBody: { name: "remote-rename-file-new.txt" },
          fields: "id,name",
        }),
        drive.files.update({
          fileId: remoteRenameDir.id,
          requestBody: { name: "remote-rename-dir-new" },
          fields: "id,name",
        }),
      ]);

      await Promise.all([
        fs.rm(path.join(workspaceRoot, "local-delete-file.txt")),
        fs.rmdir(path.join(workspaceRoot, "local-delete-dir")),
        writeLocalFile(
          workspaceRoot,
          "local-added-file.txt",
          "local added file\n"
        ),
        fs.mkdir(path.join(workspaceRoot, "local-added-dir")),
        fs.rename(
          path.join(workspaceRoot, "local-rename-file-old.txt"),
          path.join(workspaceRoot, "local-rename-file-new.txt")
        ),
        fs.rename(
          path.join(workspaceRoot, "local-rename-dir-old"),
          path.join(workspaceRoot, "local-rename-dir-new")
        ),
      ]);

      const remote = await getRemoteState(drive, folderId, null, {
        refreshRemoteMemo: true,
      });
      const local = await scanLocal(workspaceRoot);
      const diff = computeDiff(baselineSnapshot, remote.files, local, {
        root: workspaceRoot,
      });

      assert.deepEqual(changeActions(diff), {
        "local-added-dir": "upload",
        "local-added-file.txt": "upload",
        "local-delete-dir": "delete_remote",
        "local-delete-file.txt": "delete_remote",
        "local-rename-dir-new": "upload",
        "local-rename-dir-old": "delete_remote",
        "local-rename-file-new.txt": "upload",
        "local-rename-file-old.txt": "delete_remote",
        "remote-added-dir": "download",
        "remote-added-file.txt": "download",
        "remote-delete-dir": "delete_local",
        "remote-delete-file.txt": "delete_local",
        "remote-rename-dir-new": "move_local",
        "remote-rename-file-new.txt": "download",
        "remote-rename-file-old.txt": "delete_local",
      });

      assert.equal(stageChanges(workspaceRoot, diff.changes), 15);

      const result = await executeStaged(drive, workspaceRoot);
      assert.deepEqual(result.errors, []);
      assert.equal(result.downloaded, 2);
      assert.equal(result.uploaded, 2);
      assert.equal(result.foldersCreated, 3);
      assert.equal(result.deletedLocal, 3);
      assert.equal(result.deletedRemote, 4);
      assert.equal(readIndex(workspaceRoot).staged.length, 0);

      await assert.rejects(
        fs.stat(path.join(workspaceRoot, "remote-delete-file.txt")),
        { code: "ENOENT" }
      );
      await assert.rejects(
        fs.stat(path.join(workspaceRoot, "remote-delete-dir")),
        { code: "ENOENT" }
      );
      await assert.rejects(
        fs.stat(path.join(workspaceRoot, "remote-rename-file-old.txt")),
        { code: "ENOENT" }
      );
      await assert.rejects(
        fs.stat(path.join(workspaceRoot, "remote-rename-dir-old")),
        { code: "ENOENT" }
      );
      assert.equal(
        await fs.readFile(path.join(workspaceRoot, "remote-added-file.txt"), "utf8"),
        "remote added file\n"
      );
      assert.equal(
        await fs.readFile(
          path.join(workspaceRoot, "remote-rename-file-new.txt"),
          "utf8"
        ),
        "remote rename file baseline\n"
      );
      await fs.stat(path.join(workspaceRoot, "remote-added-dir"));
      await fs.stat(path.join(workspaceRoot, "remote-rename-dir-new"));

      const finalRemote = await getRemoteState(drive, folderId, null, {
        refreshRemoteMemo: true,
      });
      assert.deepEqual(
        finalRemote.files.map((item) => item.path).sort(),
        [
          "local-added-dir",
          "local-added-file.txt",
          "local-rename-dir-new",
          "local-rename-file-new.txt",
          "remote-added-dir",
          "remote-added-file.txt",
          "remote-rename-dir-new",
          "remote-rename-file-new.txt",
        ]
      );

      const directChildren = await listDirectChildren(drive, folderId);
      assert.equal(
        directChildren.every((item) => KNOWN_TEST_NAMES.has(item.name)),
        true
      );
      assert.ok(
        directChildren.some((item) => item.name === "remote-rename-file-new.txt")
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await resetKnownChildren(drive, folderId);
    }
  }
);

test(
  "live Google Drive sync preserves nested trees during parent and subfolder renames",
  {
    skip: LIVE_TEST_ENABLED
      ? false
      : "Set AETHEL_LIVE_DRIVE_TEST=1 to run against real Google Drive",
    concurrency: false,
  },
  async () => {
    resetFolderLookupCache();

    const drive = withDriveRetry(await authenticate());
    const parentFolderId = await ensureFolder(drive, LIVE_FOLDER_NAME, null);
    const folderId = await ensureFolder(
      drive,
      NESTED_RENAME_RUN_FOLDER_NAME,
      parentFolderId
    );
    await resetKnownChildren(drive, folderId, NESTED_RENAME_TEST_NAMES);

    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "aethel-live-drive-nested-renames-")
    );

    try {
      initWorkspace(
        workspaceRoot,
        folderId,
        `${LIVE_FOLDER_NAME}/${NESTED_RENAME_RUN_FOLDER_NAME}`
      );

      const remoteParentOld = await createRemoteFolder(
        drive,
        folderId,
        "remote-parent-old"
      );
      const remoteParentChild = await createRemoteFolder(
        drive,
        remoteParentOld.id,
        "child-old"
      );
      const remoteParentGrandchild = await createRemoteFolder(
        drive,
        remoteParentChild.id,
        "grandchild"
      );
      await createRemoteFile(
        drive,
        remoteParentGrandchild.id,
        "leaf.txt",
        "remote parent rename baseline\n"
      );

      const remoteSubtree = await createRemoteFolder(
        drive,
        folderId,
        "remote-subtree"
      );
      const remoteSubfolderOld = await createRemoteFolder(
        drive,
        remoteSubtree.id,
        "child-old"
      );
      const remoteSubfolderGrandchild = await createRemoteFolder(
        drive,
        remoteSubfolderOld.id,
        "grandchild"
      );
      await createRemoteFile(
        drive,
        remoteSubfolderGrandchild.id,
        "leaf.txt",
        "remote subfolder rename baseline\n"
      );

      const localParentOld = await createRemoteFolder(
        drive,
        folderId,
        "local-parent-old"
      );
      const localParentChild = await createRemoteFolder(
        drive,
        localParentOld.id,
        "child-old"
      );
      const localParentGrandchild = await createRemoteFolder(
        drive,
        localParentChild.id,
        "grandchild"
      );
      await createRemoteFile(
        drive,
        localParentGrandchild.id,
        "leaf.txt",
        "local parent rename baseline\n"
      );

      const localSubtree = await createRemoteFolder(
        drive,
        folderId,
        "local-subtree"
      );
      const localSubfolderOld = await createRemoteFolder(
        drive,
        localSubtree.id,
        "child-old"
      );
      const localSubfolderGrandchild = await createRemoteFolder(
        drive,
        localSubfolderOld.id,
        "grandchild"
      );
      await createRemoteFile(
        drive,
        localSubfolderGrandchild.id,
        "leaf.txt",
        "local subfolder rename baseline\n"
      );

      await writeLocalFile(
        workspaceRoot,
        "remote-parent-old/child-old/grandchild/leaf.txt",
        "remote parent rename baseline\n"
      );
      await writeLocalFile(
        workspaceRoot,
        "remote-subtree/child-old/grandchild/leaf.txt",
        "remote subfolder rename baseline\n"
      );
      await writeLocalFile(
        workspaceRoot,
        "local-parent-old/child-old/grandchild/leaf.txt",
        "local parent rename baseline\n"
      );
      await writeLocalFile(
        workspaceRoot,
        "local-subtree/child-old/grandchild/leaf.txt",
        "local subfolder rename baseline\n"
      );

      const baselineRemote = await getRemoteState(drive, folderId);
      const baselineLocal = await scanLocal(workspaceRoot);
      const baselineSnapshot = buildSnapshot(
        baselineRemote.files,
        baselineLocal,
        "live Google Drive nested rename baseline"
      );
      writeSnapshot(workspaceRoot, baselineSnapshot);

      await drive.files.update({
        fileId: remoteParentOld.id,
        requestBody: { name: "remote-parent-new" },
        fields: "id,name",
      });
      await drive.files.update({
        fileId: remoteParentChild.id,
        requestBody: { name: "child-new" },
        fields: "id,name",
      });
      await drive.files.update({
        fileId: remoteSubfolderOld.id,
        requestBody: { name: "child-new" },
        fields: "id,name",
      });
      await fs.rename(
        path.join(workspaceRoot, "local-parent-old"),
        path.join(workspaceRoot, "local-parent-new")
      );
      await fs.rename(
        path.join(workspaceRoot, "local-parent-new", "child-old"),
        path.join(workspaceRoot, "local-parent-new", "child-new")
      );
      await fs.rename(
        path.join(workspaceRoot, "local-subtree", "child-old"),
        path.join(workspaceRoot, "local-subtree", "child-new")
      );

      const remote = await getRemoteState(drive, folderId, null, {
        refreshRemoteMemo: true,
      });
      const local = await scanLocal(workspaceRoot);
      const diff = computeDiff(baselineSnapshot, remote.files, local, {
        root: workspaceRoot,
      });

      assert.deepEqual(changeActions(diff), {
        "local-parent-new": "rename_remote",
        "local-parent-new/child-new": "rename_remote",
        "local-subtree/child-new": "rename_remote",
        "remote-parent-new": "move_local",
        "remote-parent-new/child-new": "move_local",
        "remote-subtree/child-new": "move_local",
      });
      assert.equal(stageChanges(workspaceRoot, diff.changes), 6);

      const result = await executeStaged(drive, workspaceRoot);
      assert.deepEqual(result.errors, []);
      assert.equal(result.foldersRenamed, 3);
      assert.equal(readIndex(workspaceRoot).staged.length, 0);

      const expectedLocalFiles = [
        "local-parent-new/child-new/grandchild/leaf.txt",
        "local-subtree/child-new/grandchild/leaf.txt",
        "remote-parent-new/child-new/grandchild/leaf.txt",
        "remote-subtree/child-new/grandchild/leaf.txt",
      ];
      for (const relativePath of expectedLocalFiles) {
        await fs.stat(path.join(workspaceRoot, relativePath));
      }
      await assert.rejects(
        fs.stat(path.join(workspaceRoot, "remote-parent-old")),
        { code: "ENOENT" }
      );
      await assert.rejects(
        fs.stat(path.join(workspaceRoot, "remote-subtree", "child-old")),
        { code: "ENOENT" }
      );

      const finalRemote = await getRemoteState(drive, folderId, null, {
        refreshRemoteMemo: true,
      });
      const remotePaths = new Set(finalRemote.files.map((item) => item.path));
      for (const relativePath of expectedLocalFiles) {
        assert.equal(remotePaths.has(relativePath), true, relativePath);
      }
      assert.equal(remotePaths.has("remote-parent-old"), false);
      assert.equal(remotePaths.has("remote-parent-new/child-old"), false);
      assert.equal(remotePaths.has("remote-subtree/child-old"), false);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await resetKnownChildren(drive, folderId, NESTED_RENAME_TEST_NAMES);
    }
  }
);

test(
  "live Google Drive sync reports file rename versus deletion conflicts",
  {
    skip: LIVE_TEST_ENABLED
      ? false
      : "Set AETHEL_LIVE_DRIVE_TEST=1 to run against real Google Drive",
  },
  async () => {
    resetFolderLookupCache();

    const drive = withDriveRetry(await authenticate());
    const parentFolderId = await ensureFolder(drive, LIVE_FOLDER_NAME, null);
    const folderId = await ensureFolder(
      drive,
      RENAME_DELETE_RUN_FOLDER_NAME,
      parentFolderId
    );
    await resetKnownChildren(drive, folderId, RENAME_DELETE_TEST_NAMES);

    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "aethel-live-drive-rename-delete-")
    );

    try {
      initWorkspace(
        workspaceRoot,
        folderId,
        `${LIVE_FOLDER_NAME}/${RENAME_DELETE_RUN_FOLDER_NAME}`
      );

      const remoteDeleteFile = await createRemoteFile(
        drive,
        folderId,
        "local-rename-remote-delete-old.txt",
        "local rename, remote deletion baseline\n"
      );
      const remoteRenameFile = await createRemoteFile(
        drive,
        folderId,
        "remote-rename-local-delete-old.txt",
        "remote rename, local deletion baseline\n"
      );
      await writeLocalFile(
        workspaceRoot,
        "local-rename-remote-delete-old.txt",
        "local rename, remote deletion baseline\n"
      );
      await writeLocalFile(
        workspaceRoot,
        "remote-rename-local-delete-old.txt",
        "remote rename, local deletion baseline\n"
      );

      const baselineRemote = await getRemoteState(drive, folderId);
      const baselineLocal = await scanLocal(workspaceRoot);
      const baselineSnapshot = buildSnapshot(
        baselineRemote.files,
        baselineLocal,
        "live Google Drive rename/delete conflict baseline"
      );
      writeSnapshot(workspaceRoot, baselineSnapshot);

      await drive.files.update({
        fileId: remoteDeleteFile.id,
        requestBody: { trashed: true },
        fields: "id,trashed",
      });
      await drive.files.update({
        fileId: remoteRenameFile.id,
        requestBody: { name: "remote-rename-local-delete-new.txt" },
        fields: "id,name",
      });
      await fs.rename(
        path.join(workspaceRoot, "local-rename-remote-delete-old.txt"),
        path.join(workspaceRoot, "local-rename-remote-delete-new.txt")
      );
      await fs.rm(
        path.join(workspaceRoot, "remote-rename-local-delete-old.txt")
      );

      const remote = await getRemoteState(drive, folderId, null, {
        refreshRemoteMemo: true,
      });
      const local = await scanLocal(workspaceRoot);
      const diff = computeDiff(baselineSnapshot, remote.files, local, {
        root: workspaceRoot,
      });

      assert.deepEqual(changeActions(diff), {
        "local-rename-remote-delete-new.txt": "conflict",
        "remote-rename-local-delete-new.txt": "conflict",
      });
      assert.equal(diff.conflicts.length, 2);
      assert.equal(stageChanges(workspaceRoot, diff.changes), 2);
      assert.equal(readIndex(workspaceRoot).staged.length, 2);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await resetKnownChildren(drive, folderId, RENAME_DELETE_TEST_NAMES);
    }
  }
);
