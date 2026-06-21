import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChangeType,
  computeDiff,
  changesWithLocalAuthority,
} from "../src/core/diff.js";

test("computeDiff carries snapshot Drive IDs for local changes", () => {
  const snapshot = {
    files: {
      "remote-1": {
        id: "remote-1",
        path: "docs/changed.md",
        localPath: "docs/changed.md",
        md5Checksum: "old-remote",
      },
      "remote-2": {
        id: "remote-2",
        path: "docs/deleted.md",
        localPath: "docs/deleted.md",
        md5Checksum: "deleted-remote",
      },
    },
    localFiles: {
      "docs/changed.md": {
        localPath: "docs/changed.md",
        md5: "old-local",
      },
      "docs/deleted.md": {
        localPath: "docs/deleted.md",
        md5: "deleted-local",
      },
    },
  };

  const remoteFiles = [
    {
      id: "remote-1",
      path: "docs/changed.md",
      md5Checksum: "old-remote",
    },
    {
      id: "remote-2",
      path: "docs/deleted.md",
      md5Checksum: "deleted-remote",
    },
  ];

  const localFiles = {
    "docs/changed.md": {
      localPath: "docs/changed.md",
      md5: "new-local",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);
  const changed = diff.changes.find(
    (change) => change.changeType === ChangeType.LOCAL_MODIFIED
  );
  const deleted = diff.changes.find(
    (change) => change.changeType === ChangeType.LOCAL_DELETED
  );

  assert.equal(changed.fileId, "remote-1");
  assert.equal(deleted.fileId, "remote-2");
  assert.equal(deleted.suggestedAction, "delete_remote");
});

test("computeDiff treats same-path remote ID replacement as a modification", () => {
  const snapshot = {
    files: {
      "old-remote-id": {
        id: "old-remote-id",
        path: "docs/report.md",
        localPath: "docs/report.md",
        md5Checksum: "old-md5",
      },
    },
    localFiles: {
      "docs/report.md": {
        localPath: "docs/report.md",
        md5: "old-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "new-remote-id",
      path: "docs/report.md",
      md5Checksum: "new-md5",
    },
  ];

  const localFiles = {
    "docs/report.md": {
      localPath: "docs/report.md",
      md5: "old-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.REMOTE_MODIFIED]
  );
  assert.equal(diff.changes[0].fileId, "new-remote-id");
  assert.equal(diff.changes[0].suggestedAction, "download");
});

test("computeDiff refreshes same-path remote ID replacement with unchanged content", () => {
  const snapshot = {
    files: {
      "old-remote-id": {
        id: "old-remote-id",
        path: "docs/report.md",
        localPath: "docs/report.md",
        md5Checksum: "same-md5",
      },
    },
    localFiles: {
      "docs/report.md": {
        localPath: "docs/report.md",
        md5: "same-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "new-remote-id",
      path: "docs/report.md",
      md5Checksum: "same-md5",
    },
  ];

  const localFiles = {
    "docs/report.md": {
      localPath: "docs/report.md",
      md5: "same-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.REMOTE_MODIFIED]
  );
  assert.equal(diff.changes[0].fileId, "new-remote-id");
  assert.equal(diff.changes[0].suggestedAction, "download");
});

test("computeDiff downloads remote snapshot entries that are absent from the local baseline", () => {
  const snapshot = {
    files: {
      "remote-only": {
        id: "remote-only",
        path: "Planning/Atlas/note.md",
        md5Checksum: "remote-md5",
      },
    },
    localFiles: {},
  };

  const remoteFiles = [
    {
      id: "remote-only",
      path: "Planning/Atlas/note.md",
      md5Checksum: "remote-md5",
    },
  ];

  const diff = computeDiff(snapshot, remoteFiles, {});

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.REMOTE_ADDED]
  );
  assert.equal(diff.changes[0].path, "Planning/Atlas/note.md");
  assert.equal(diff.changes[0].fileId, "remote-only");
  assert.equal(diff.changes[0].suggestedAction, "download");
});

test("changesWithLocalAuthority converts remote-only additions into remote deletes", () => {
  const remoteOnly = {
    changeType: ChangeType.REMOTE_ADDED,
    path: "docs/remote-only.md",
    fileId: "remote-only",
    remoteMeta: { id: "remote-only", path: "docs/remote-only.md" },
    localMeta: null,
    snapshotMeta: null,
    shortStatus: "+R",
    description: "new on Drive",
    suggestedAction: "download",
  };

  const changes = changesWithLocalAuthority([remoteOnly]);

  assert.deepEqual(changes, [
    {
      changeType: ChangeType.LOCAL_DELETED,
      path: "docs/remote-only.md",
      fileId: "remote-only",
      remoteMeta: { id: "remote-only", path: "docs/remote-only.md" },
      localMeta: null,
      snapshotMeta: null,
      shortStatus: "-L",
      description: "deleted locally",
      suggestedAction: "delete_remote",
    },
  ]);
});

test("changesWithLocalAuthority collapses remote-only paths to missing local ancestors", () => {
  const remoteOnly = {
    changeType: ChangeType.REMOTE_ADDED,
    path: "docs/generated/build/output.o",
    fileId: "remote-child",
    remoteMeta: { id: "remote-child", path: "docs/generated/build/output.o" },
    localMeta: null,
    snapshotMeta: null,
    shortStatus: "+R",
    description: "new on Drive",
    suggestedAction: "download",
  };
  const existingPaths = new Set(["docs"]);

  const changes = changesWithLocalAuthority([remoteOnly], {
    pathExists: (candidate) => existingPaths.has(candidate),
  });

  assert.deepEqual(changes, [
    {
      changeType: ChangeType.LOCAL_DELETED,
      path: "docs/generated",
      fileId: null,
      remoteMeta: null,
      localMeta: null,
      snapshotMeta: null,
      shortStatus: "-L",
      description: "deleted locally",
      suggestedAction: "delete_remote",
    },
  ]);
});

test("changesWithLocalAuthority deduplicates collapsed remote deletes", () => {
  const remoteChanges = [
    {
      changeType: ChangeType.REMOTE_ADDED,
      path: "docs/generated/build/a.o",
      fileId: "remote-a",
      remoteMeta: { id: "remote-a", path: "docs/generated/build/a.o" },
      localMeta: null,
      snapshotMeta: null,
      shortStatus: "+R",
      description: "new on Drive",
      suggestedAction: "download",
    },
    {
      changeType: ChangeType.REMOTE_ADDED,
      path: "docs/generated/build/b.o",
      fileId: "remote-b",
      remoteMeta: { id: "remote-b", path: "docs/generated/build/b.o" },
      localMeta: null,
      snapshotMeta: null,
      shortStatus: "+R",
      description: "new on Drive",
      suggestedAction: "download",
    },
  ];
  const existingPaths = new Set(["docs"]);

  const changes = changesWithLocalAuthority(remoteChanges, {
    pathExists: (candidate) => existingPaths.has(candidate),
  });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "docs/generated");
});

test("computeDiff conflicts when remote baseline-only file differs from local file", () => {
  const snapshot = {
    files: {
      "remote-only": {
        id: "remote-only",
        path: "Planning/overview.md",
        md5Checksum: "remote-md5",
      },
    },
    localFiles: {},
  };

  const remoteFiles = [
    {
      id: "remote-only",
      path: "Planning/overview.md",
      md5Checksum: "remote-md5",
    },
  ];

  const localFiles = {
    "Planning/overview.md": {
      localPath: "Planning/overview.md",
      md5: "local-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.CONFLICT]
  );
  assert.equal(diff.changes[0].path, "Planning/overview.md");
  assert.equal(diff.changes[0].fileId, "remote-only");
  assert.equal(diff.changes[0].suggestedAction, "conflict");
  assert.equal(diff.changes[0].remoteMeta.md5Checksum, "remote-md5");
  assert.equal(diff.changes[0].localMeta.md5, "local-md5");
});

test("computeDiff does not upload duplicate local files when remote baseline-only content matches", () => {
  const snapshot = {
    files: {
      "remote-only": {
        id: "remote-only",
        path: "Planning/overview.md",
        md5Checksum: "same-md5",
      },
    },
    localFiles: {},
  };

  const remoteFiles = [
    {
      id: "remote-only",
      path: "Planning/overview.md",
      md5Checksum: "same-md5",
    },
  ];

  const localFiles = {
    "Planning/overview.md": {
      localPath: "Planning/overview.md",
      md5: "same-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(diff.changes, []);
});

test("computeDiff keeps local deletion semantics for files that were synced locally", () => {
  const snapshot = {
    files: {
      "synced-remote": {
        id: "synced-remote",
        path: "docs/synced.md",
        localPath: "docs/synced.md",
        md5Checksum: "same-md5",
      },
    },
    localFiles: {
      "docs/synced.md": {
        localPath: "docs/synced.md",
        md5: "same-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "synced-remote",
      path: "docs/synced.md",
      md5Checksum: "same-md5",
    },
  ];

  const diff = computeDiff(snapshot, remoteFiles, {});

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.LOCAL_DELETED]
  );
  assert.equal(diff.changes[0].suggestedAction, "delete_remote");
});

test("computeDiff collapses local deletion of non-empty remote folder to parent folder delete", () => {
  const snapshot = {
    files: {
      "remote-folder": {
        id: "remote-folder",
        path: "build/app.dSYM",
        localPath: "build/app.dSYM",
        isFolder: true,
      },
      "remote-info": {
        id: "remote-info",
        path: "build/app.dSYM/Contents/Info.plist",
        localPath: "build/app.dSYM/Contents/Info.plist",
        md5Checksum: "info-md5",
      },
      "remote-binary": {
        id: "remote-binary",
        path: "build/app.dSYM/Contents/Resources/DWARF/app",
        localPath: "build/app.dSYM/Contents/Resources/DWARF/app",
        md5Checksum: "binary-md5",
      },
    },
    localFiles: {
      "build/app.dSYM/Contents/Info.plist": {
        localPath: "build/app.dSYM/Contents/Info.plist",
        md5: "info-md5",
      },
      "build/app.dSYM/Contents/Resources/DWARF/app": {
        localPath: "build/app.dSYM/Contents/Resources/DWARF/app",
        md5: "binary-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "remote-folder",
      path: "build/app.dSYM",
      isFolder: true,
    },
    {
      id: "remote-info",
      path: "build/app.dSYM/Contents/Info.plist",
      md5Checksum: "info-md5",
    },
    {
      id: "remote-binary",
      path: "build/app.dSYM/Contents/Resources/DWARF/app",
      md5Checksum: "binary-md5",
    },
  ];

  const diff = computeDiff(snapshot, remoteFiles, {});

  assert.deepEqual(
    diff.changes.map((change) => ({
      type: change.changeType,
      path: change.path,
      action: change.suggestedAction,
      fileId: change.fileId,
    })),
    [
      {
        type: ChangeType.LOCAL_DELETED,
        path: "build/app.dSYM",
        action: "delete_remote",
        fileId: "remote-folder",
      },
    ]
  );
});

test("computeDiff treats remote additions under a locally deleted snapshot folder as parent folder delete", () => {
  const snapshot = {
    files: {},
    localFiles: {
      "01_Courses/00_Compiler/IC_Lab/specs/lab1.pdf": {
        localPath: "01_Courses/00_Compiler/IC_Lab/specs/lab1.pdf",
        md5: "lab-md5",
      },
      "01_Courses/00_Compiler/cbc-1.0/import/sys": {
        localPath: "01_Courses/00_Compiler/cbc-1.0/import/sys",
        md5: "sys-md5",
      },
      "01_Courses/03_C/AP325/main.c": {
        localPath: "01_Courses/03_C/AP325/main.c",
        md5: "other-course-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "compiler-folder",
      path: "01_Courses/00_Compiler",
      isFolder: true,
    },
    {
      id: "specs-folder",
      path: "01_Courses/00_Compiler/IC_Lab/specs",
      isFolder: true,
    },
    {
      id: "lab-file",
      path: "01_Courses/00_Compiler/IC_Lab/specs/lab1.pdf",
      md5Checksum: "lab-md5",
    },
    {
      id: "sys-file",
      path: "01_Courses/00_Compiler/cbc-1.0/import/sys",
      md5Checksum: "sys-md5",
    },
  ];

  const localFiles = {
    "01_Courses/03_C/AP325/main.c": {
      localPath: "01_Courses/03_C/AP325/main.c",
      md5: "other-course-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => ({
      type: change.changeType,
      path: change.path,
      action: change.suggestedAction,
      fileId: change.fileId,
    })),
    [
      {
        type: ChangeType.LOCAL_DELETED,
        path: "01_Courses/00_Compiler",
        action: "delete_remote",
        fileId: "compiler-folder",
      },
    ]
  );
});

test("computeDiff ignores files deleted on both local and Drive", () => {
  const snapshot = {
    files: {
      "synced-remote": {
        id: "synced-remote",
        path: "docs/deleted.md",
        localPath: "docs/deleted.md",
        md5Checksum: "same-md5",
      },
    },
    localFiles: {
      "docs/deleted.md": {
        localPath: "docs/deleted.md",
        md5: "same-md5",
      },
    },
  };

  const diff = computeDiff(snapshot, [], {});

  assert.deepEqual(diff.changes, []);
});

test("computeDiff ignores folders deleted on both local and Drive", () => {
  const snapshot = {
    files: {
      "folder-remote": {
        id: "folder-remote",
        path: "docs/archive",
        localPath: "docs/archive",
        isFolder: true,
      },
    },
    localFiles: {
      "docs/archive": {
        localPath: "docs/archive",
        isFolder: true,
      },
    },
  };

  const diff = computeDiff(snapshot, [], {});

  assert.deepEqual(diff.changes, []);
});

test("computeDiff lets remote-deleted folders delete matching local folders without local baseline", () => {
  const snapshot = {
    files: {
      "folder-remote": {
        id: "folder-remote",
        path: "docs/generated",
        localPath: "docs/generated",
        isFolder: true,
      },
    },
    localFiles: {},
  };

  const localFiles = {
    "docs/generated": {
      localPath: "docs/generated",
      isFolder: true,
    },
  };

  const diff = computeDiff(snapshot, [], localFiles);

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.REMOTE_DELETED]
  );
  assert.equal(diff.changes[0].path, "docs/generated");
  assert.equal(diff.changes[0].suggestedAction, "delete_local");
});

test("computeDiff collapses remote deletion of non-empty folder to parent local delete", () => {
  const snapshot = {
    files: {
      "remote-a": {
        id: "remote-a",
        path: "courses/compiler/specs/lab1.pdf",
        localPath: "courses/compiler/specs/lab1.pdf",
        md5Checksum: "lab-md5",
      },
      "remote-b": {
        id: "remote-b",
        path: "courses/compiler/src/main.c",
        localPath: "courses/compiler/src/main.c",
        md5Checksum: "main-md5",
      },
      "remote-sibling": {
        id: "remote-sibling",
        path: "courses/math/notes.md",
        localPath: "courses/math/notes.md",
        md5Checksum: "math-md5",
      },
    },
    localFiles: {
      "courses/compiler/specs/lab1.pdf": {
        localPath: "courses/compiler/specs/lab1.pdf",
        md5: "lab-md5",
      },
      "courses/compiler/src/main.c": {
        localPath: "courses/compiler/src/main.c",
        md5: "main-md5",
      },
      "courses/math/notes.md": {
        localPath: "courses/math/notes.md",
        md5: "math-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "remote-sibling",
      path: "courses/math/notes.md",
      md5Checksum: "math-md5",
    },
  ];

  const localFiles = {
    "courses/compiler/specs/lab1.pdf": {
      localPath: "courses/compiler/specs/lab1.pdf",
      md5: "lab-md5",
    },
    "courses/compiler/src/main.c": {
      localPath: "courses/compiler/src/main.c",
      md5: "main-md5",
    },
    "courses/math/notes.md": {
      localPath: "courses/math/notes.md",
      md5: "math-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => ({
      type: change.changeType,
      path: change.path,
      action: change.suggestedAction,
      isFolder: change.snapshotMeta?.isFolder,
    })),
    [
      {
        type: ChangeType.REMOTE_DELETED,
        path: "courses/compiler",
        action: "delete_local",
        isFolder: true,
      },
    ]
  );
});

test("computeDiff ignores historical snapshot entries that now match .aethelignore", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-diff-"));

  try {
    fs.writeFileSync(path.join(root, ".aethelignore"), "Debug/\n");

    const snapshot = {
      files: {
        "remote-debug": {
          id: "remote-debug",
          path: "project/Debug/build.o",
          localPath: "project/Debug/build.o",
          md5Checksum: "debug-md5",
        },
      },
      localFiles: {
        "project/Debug/build.o": {
          localPath: "project/Debug/build.o",
          md5: "debug-md5",
        },
      },
    };

    const remoteFiles = [
      {
        id: "remote-debug",
        path: "project/Debug/build.o",
        md5Checksum: "debug-md5",
      },
    ];

    const localFiles = {
      "project/Debug/build.o": {
        localPath: "project/Debug/build.o",
        md5: "changed-debug-md5",
      },
    };

    const diff = computeDiff(snapshot, remoteFiles, localFiles, { root });

    assert.deepEqual(diff.changes, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
