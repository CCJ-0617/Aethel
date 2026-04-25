import test from "node:test";
import assert from "node:assert/strict";
import { ChangeType, computeDiff } from "../src/core/diff.js";

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
