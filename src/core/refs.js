import fs from "node:fs";
import path from "node:path";
import {
  AETHEL_DIR,
  HISTORY_DIR,
  LATEST_SNAPSHOT,
  SNAPSHOTS_DIR,
  readLatestSnapshot,
} from "./config.js";

export function snapshotRef(snapshot) {
  return String(snapshot?.timestamp || "snapshot").replace(/[-:TZ.]/g, "").slice(0, 12);
}

function validateRefName(name, kind) {
  if (!/^[A-Za-z0-9._/-]+$/.test(name || "")) {
    throw new Error(`${kind} names may contain letters, numbers, '.', '_', '-', and '/'.`);
  }
}

function tagsPath(root) {
  return path.join(root, AETHEL_DIR, "refs", "tags.json");
}

function branchesPath(root) {
  return path.join(root, AETHEL_DIR, "refs", "branches.json");
}

function readTagsFile(root) {
  const p = tagsPath(root);
  if (!fs.existsSync(p)) {
    return { tags: {} };
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeTagsFile(root, data) {
  const p = tagsPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

function branchEntry(snapshot) {
  return {
    ref: snapshotRef(snapshot),
    timestamp: snapshot?.timestamp || null,
    message: snapshot?.message || "",
    updatedAt: new Date().toISOString(),
  };
}

function readBranchesFile(root) {
  const p = branchesPath(root);
  if (!fs.existsSync(p)) {
    const latest = readLatestSnapshot(root);
    return {
      current: "main",
      branches: {
        main: latest
          ? branchEntry(latest)
          : { ref: null, timestamp: null, message: "", updatedAt: null },
      },
    };
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeBranchesFile(root, data) {
  const p = branchesPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  data.current ||= "main";
  data.branches ||= {};
  data.branches.main ||= { ref: null, timestamp: null, message: "", updatedAt: null };
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

export function getHistory(root, limit = 10) {
  const snapshotsPath = path.join(root, AETHEL_DIR, SNAPSHOTS_DIR);
  const entries = [];

  const latestPath = path.join(snapshotsPath, LATEST_SNAPSHOT);
  if (fs.existsSync(latestPath)) {
    entries.push(JSON.parse(fs.readFileSync(latestPath, "utf8")));
  }

  const historyPath = path.join(snapshotsPath, HISTORY_DIR);
  if (fs.existsSync(historyPath)) {
    const historyFiles = fs
      .readdirSync(historyPath)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();

    for (const fileName of historyFiles) {
      entries.push(
        JSON.parse(fs.readFileSync(path.join(historyPath, fileName), "utf8"))
      );
    }
  }

  return entries.slice(0, limit);
}

export function getTags(root) {
  return readTagsFile(root).tags || {};
}

export function getBranches(root) {
  const data = readBranchesFile(root);
  return {
    current: data.current || "main",
    branches: data.branches || {},
  };
}

export function createBranch(root, name, ref = "HEAD", { force = false } = {}) {
  validateRefName(name, "Branch");
  const data = readBranchesFile(root);
  data.branches ||= {};

  if (data.branches[name] && !force) {
    throw new Error(`Branch '${name}' already exists. Use --force to replace it.`);
  }

  const snapshot = getSnapshotByRef(root, ref);
  if (!snapshot) {
    throw new Error(`No snapshot matching '${ref}' found.`);
  }

  const entry = branchEntry(snapshot);
  data.branches[name] = entry;
  writeBranchesFile(root, data);
  return entry;
}

export function switchBranch(root, name, { create = false, ref = "HEAD" } = {}) {
  validateRefName(name, "Branch");
  const data = readBranchesFile(root);
  data.branches ||= {};

  if (!data.branches[name]) {
    if (!create) {
      throw new Error(`Unknown branch '${name}'. Use 'aethel switch -c ${name}' to create it.`);
    }
    const snapshot = getSnapshotByRef(root, ref);
    if (!snapshot) {
      throw new Error(`No snapshot matching '${ref}' found.`);
    }
    data.branches[name] = branchEntry(snapshot);
  }

  data.current = name;
  writeBranchesFile(root, data);
  return data.branches[name];
}

export function deleteBranch(root, name) {
  const data = readBranchesFile(root);
  if ((data.current || "main") === name) {
    throw new Error(`Cannot delete the current branch '${name}'.`);
  }
  if (!data.branches?.[name]) {
    return false;
  }
  delete data.branches[name];
  writeBranchesFile(root, data);
  return true;
}

export function updateCurrentBranch(root, snapshot) {
  const data = readBranchesFile(root);
  const current = data.current || "main";
  data.branches ||= {};
  data.branches[current] = branchEntry(snapshot);
  writeBranchesFile(root, data);
}

export function createTag(root, name, ref = "HEAD", { force = false } = {}) {
  validateRefName(name, "Tag");

  const data = readTagsFile(root);
  data.tags ||= {};

  if (data.tags[name] && !force) {
    throw new Error(`Tag '${name}' already exists. Use --force to replace it.`);
  }

  const snapshot = getSnapshotByRef(root, ref);
  if (!snapshot) {
    throw new Error(`No snapshot matching '${ref}' found.`);
  }

  const tag = {
    ref: snapshotRef(snapshot),
    timestamp: snapshot.timestamp || null,
    message: snapshot.message || "",
    createdAt: new Date().toISOString(),
  };

  data.tags[name] = tag;
  writeTagsFile(root, data);
  return tag;
}

export function deleteTag(root, name) {
  const data = readTagsFile(root);
  if (!data.tags?.[name]) {
    return false;
  }
  delete data.tags[name];
  writeTagsFile(root, data);
  return true;
}

export function getSnapshotByRef(root, ref) {
  if (!ref || ref === "HEAD" || ref === "latest") {
    return readLatestSnapshot(root);
  }

  const tag = getTags(root)[ref];
  if (tag?.ref && tag.ref !== ref) {
    return getSnapshotByRef(root, tag.ref);
  }

  const branch = getBranches(root).branches?.[ref];
  if (branch?.ref && branch.ref !== ref) {
    return getSnapshotByRef(root, branch.ref);
  }

  const matchesRef = (snapshot) => {
    const normalized = snapshotRef(snapshot);
    return normalized.startsWith(ref) || String(snapshot?.timestamp || "").startsWith(ref);
  };

  const latest = readLatestSnapshot(root);
  if (latest && matchesRef(latest)) {
    return latest;
  }

  const historyPath = path.join(root, AETHEL_DIR, SNAPSHOTS_DIR, HISTORY_DIR);
  if (!fs.existsSync(historyPath)) {
    return null;
  }

  const files = fs
    .readdirSync(historyPath)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  for (const file of files) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(historyPath, file), "utf-8"));
    if (file.startsWith(ref) || matchesRef(snapshot)) {
      return snapshot;
    }
  }

  return null;
}
