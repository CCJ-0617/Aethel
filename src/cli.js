#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { authenticate, resolveCredentialsPath, resolveTokenPath } from "./core/auth.js";
import {
  AETHEL_DIR,
  HISTORY_DIR,
  LATEST_SNAPSHOT,
  SNAPSHOTS_DIR,
  initWorkspace,
  readConfig,
  readLatestSnapshot,
  requireRoot,
  writeSnapshot,
} from "./core/config.js";
import { ChangeType, computeDiff } from "./core/diff.js";
import {
  assertNoDuplicateFolders,
  batchOperateFiles,
  dedupeDuplicateFolders,
  getRemoteState,
  getAccountInfo,
  listAccessibleFiles,
  DuplicateFoldersError,
  withDriveRetry,
} from "./core/drive-api.js";
import { createDefaultIgnoreFile, loadIgnoreRules } from "./core/ignore.js";
import { invalidateRemoteCache, readRemoteCache, writeRemoteCache } from "./core/remote-cache.js";
import { buildSnapshot, scanLocal } from "./core/snapshot.js";
import { stageChange, stageChanges, stageConflictResolution, stagedEntries, unstageAll, unstagePath } from "./core/staging.js";
import { executeStaged } from "./core/sync.js";
import { runTui } from "./tui/index.js";

const REQUIRED_CONFIRMATION = "DELETE ALL MY GOOGLE DRIVE FILES";

function addAuthOptions(command) {
  return command
    .option("--credentials <path>", "Path to OAuth client credentials JSON")
    .option("--token <path>", "Path to cached OAuth token JSON");
}

async function getDrive(options = {}) {
  const drive = await authenticate(options.credentials, options.token);
  return withDriveRetry(drive);
}

async function loadRemoteState(root, drive, config, { useCache = true } = {}) {
  const rootFolderId = config.drive_folder_id || null;
  let remoteState = useCache ? readRemoteCache(root, rootFolderId) : null;

  if (!remoteState) {
    remoteState = await getRemoteState(drive, rootFolderId);
    writeRemoteCache(root, remoteState, rootFolderId);
  }

  assertNoDuplicateFolders(remoteState.duplicateFolders);
  return remoteState;
}

function matchesPattern(targetPath, pattern) {
  if (targetPath === pattern) {
    return true;
  }

  const expression = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*");

  return new RegExp(`^${expression}$`).test(targetPath);
}

function printChangeDetail(change) {
  console.log(`  ${change.shortStatus} ${change.path}`);
  console.log(`       ${change.description}`);

  if (change.remoteMeta) {
    const remoteMd5 = change.remoteMeta.md5Checksum || "?";
    console.log(
      `       remote: md5=${String(remoteMd5).slice(0, 8)}  modified=${
        change.remoteMeta.modifiedTime || "?"
      }`
    );
  }

  if (change.localMeta) {
    const localMd5 = change.localMeta.md5 || "?";
    console.log(
      `       local:  md5=${String(localMd5).slice(0, 8)}  modified=${
        change.localMeta.modifiedTime || "?"
      }`
    );
  }

  if (change.snapshotMeta) {
    const snapshotMd5 =
      change.snapshotMeta.md5Checksum || change.snapshotMeta.md5 || "?";
    console.log(`       snap:   md5=${String(snapshotMd5).slice(0, 8)}`);
  }
}

function printCleanerPlan(files, { permanent, execute }) {
  const action = permanent ? "permanently delete" : "move to trash";
  const mode = execute ? "EXECUTION" : "DRY RUN";

  console.log(`${mode}: the script will ${action} ${files.length} file(s).`);
  for (const file of files) {
    console.log(`- ${file.name} | id=${file.id} | mimeType=${file.mimeType}`);
  }
}

function requireConfirmation(options) {
  if (!options.execute) {
    return;
  }

  if (options.confirm !== REQUIRED_CONFIRMATION) {
    throw new Error(
      `The confirmation phrase is incorrect. Pass --confirm "${REQUIRED_CONFIRMATION}" to execute.`
    );
  }
}

async function loadWorkspaceState(root, options, { useCache = true } = {}) {
  const config = readConfig(root);

  // Start auth, local scan, and snapshot read all in parallel.
  const [drive, local, snapshot] = await Promise.all([
    getDrive(options),
    scanLocal(root),
    Promise.resolve(readLatestSnapshot(root)),
  ]);

  // Try the short-lived remote cache first (saves a full API round-trip)
  const remoteState = await loadRemoteState(root, drive, config, { useCache });
  const remote = remoteState.files;

  return {
    config,
    drive,
    remote,
    local,
    snapshot,
    diff: computeDiff(snapshot, remote, local, { root }),
  };
}

async function handleAuth(options) {
  const drive = await getDrive(options);
  const account = await getAccountInfo(drive);

  console.log("OAuth initialization completed.");
  console.log(`Credentials path: ${resolveCredentialsPath(options.credentials)}`);
  console.log(`Token path: ${resolveTokenPath(options.token)}`);
  console.log(`Authenticated user: ${account.name}`);
  console.log(`Authenticated email: ${account.email}`);
  console.log(`Storage usage: ${account.usage}`);
  console.log(`Storage limit: ${account.limit}`);
}

async function handleClean(options) {
  requireConfirmation(options);
  const drive = await getDrive(options);
  const files = await listAccessibleFiles(drive, Boolean(options.sharedDrives));

  printCleanerPlan(files, options);

  if (files.length === 0) {
    console.log("No non-trashed files were found.");
    return;
  }

  if (!options.execute) {
    console.log("Dry run completed. Re-run with --execute to perform the operation.");
    return;
  }

  const result = await batchOperateFiles(drive, files, {
    permanent: Boolean(options.permanent),
    includeSharedDrives: Boolean(options.sharedDrives),
    onProgress: (done, total, verb, name) => {
      console.log(`[${done}/${total}] ${verb}: ${name}`);
    },
  });

  if (result.errors) {
    console.log(`Completed with ${result.errors} error(s) out of ${files.length} file(s).`);
  }

  console.log("Operation completed.");
}

async function handleInit(options) {
  const localPath = path.resolve(options.localPath);

  if (!fs.existsSync(localPath)) {
    await fs.promises.mkdir(localPath, { recursive: true });
  }

  const root = initWorkspace(
    localPath,
    options.driveFolder || null,
    options.driveFolderName || "My Drive"
  );

  const created = createDefaultIgnoreFile(root);
  console.log(`Initialised Aethel workspace at ${root}`);
  if (created) {
    console.log("  Created .aethelignore with default patterns");
  }
  if (options.driveFolder) {
    console.log(
      `  Drive folder: ${options.driveFolderName || "My Drive"} (${options.driveFolder})`
    );
  } else {
    console.log("  Syncing entire My Drive");
  }
}

async function handleStatus(options) {
  const root = requireRoot();
  const { diff } = await loadWorkspaceState(root, options);
  const staged = stagedEntries(root);

  if (diff.isClean && staged.length === 0) {
    console.log("Everything up to date.");
    return;
  }

  if (staged.length) {
    console.log(`\nStaged changes (${staged.length}):`);
    for (const entry of staged) {
      console.log(`  ${entry.action.padStart(15, " ")}  ${entry.path}`);
    }
  }

  if (diff.remoteChanges.length) {
    console.log(`\nRemote changes (${diff.remoteChanges.length}):`);
    for (const change of diff.remoteChanges) {
      console.log(`  ${change.shortStatus} ${change.path}  (${change.description})`);
    }
  }

  if (diff.localChanges.length) {
    console.log(`\nLocal changes (${diff.localChanges.length}):`);
    for (const change of diff.localChanges) {
      console.log(`  ${change.shortStatus} ${change.path}  (${change.description})`);
    }
  }

  if (diff.conflicts.length) {
    console.log(`\nConflicts (${diff.conflicts.length}):`);
    for (const change of diff.conflicts) {
      console.log(`  ${change.shortStatus} ${change.path}  (${change.description})`);
    }
  }

  // Display packed directories status
  if (diff.hasPackChanges) {
    const pending = diff.pendingPackChanges;
    const synced = diff.syncedPacks;
    const packConflicts = diff.packConflicts;

    if (pending.length > 0) {
      console.log(`\nPacked directories (${pending.length} pending):`);
      for (const change of pending) {
        console.log(`  ${change.shortStatus} ${change.path}/  (${change.description})`);
      }
    }

    if (packConflicts.length > 0) {
      console.log(`\nPack conflicts (${packConflicts.length}):`);
      for (const change of packConflicts) {
        console.log(`  ${change.shortStatus} ${change.path}/  (${change.description})`);
      }
    }

    if (synced.length > 0 && options.verbose) {
      console.log(`\nSynced packs (${synced.length}):`);
      for (const change of synced) {
        console.log(`  ${change.shortStatus} ${change.path}/  (${change.description})`);
      }
    }
  }
}

async function handleDiff(options) {
  const root = requireRoot();
  const { diff } = await loadWorkspaceState(root, options);

  if (diff.isClean) {
    console.log("No changes detected.");
    return;
  }

  const showRemote = options.side === "all" || options.side === "remote";
  const showLocal = options.side === "all" || options.side === "local";

  if (showRemote && diff.remoteChanges.length) {
    console.log("Remote changes:");
    for (const change of diff.remoteChanges) {
      printChangeDetail(change);
    }
  }

  if (showLocal && diff.localChanges.length) {
    console.log("Local changes:");
    for (const change of diff.localChanges) {
      printChangeDetail(change);
    }
  }

  if (diff.conflicts.length) {
    console.log("Conflicts:");
    for (const change of diff.conflicts) {
      printChangeDetail(change);
    }
  }
}

async function handleAdd(paths, options) {
  const root = requireRoot();
  const { diff } = await loadWorkspaceState(root, options);

  if (options.all) {
    const toStage = diff.changes.filter(
      (change) => change.suggestedAction !== "conflict"
    );
    const count = stageChanges(root, toStage);
    console.log(`Staged ${count} change(s).`);
    return;
  }

  const changesByPath = new Map(diff.changes.map((change) => [change.path, change]));
  let stagedCount = 0;

  for (const pattern of paths || []) {
    const matched = [...changesByPath.entries()]
      .filter(([changePath]) => matchesPattern(changePath, pattern))
      .map(([, change]) => change);

    if (matched.length === 0) {
      console.log(`  No changes match '${pattern}'`);
      continue;
    }

    for (const change of matched) {
      if (change.suggestedAction === "conflict") {
        console.log(`  !! ${change.path} is conflicted - resolve before staging`);
        continue;
      }

      stageChange(root, change);
      stagedCount += 1;
      console.log(`  Staged: ${change.path}`);
    }
  }

  console.log(`Staged ${stagedCount} change(s).`);
}

function handleReset(paths, options) {
  const root = requireRoot();

  if (options.all) {
    const count = unstageAll(root);
    console.log(`Unstaged ${count} change(s).`);
    return;
  }

  for (const targetPath of paths || []) {
    if (unstagePath(root, targetPath)) {
      console.log(`  Unstaged: ${targetPath}`);
      continue;
    }

    console.log(`  Not staged: ${targetPath}`);
  }
}

async function handleCommit(options) {
  const root = requireRoot();
  const config = readConfig(root);
  const staged = stagedEntries(root);

  if (!staged.length) {
    console.log("Nothing staged. Use 'aethel add' first.");
    return;
  }

  const drive = await getDrive(options);
  const message = options.message || "sync";
  await loadRemoteState(root, drive, config, { useCache: true });

  console.log(`Committing ${staged.length} change(s)...`);

  const result = await executeStaged(drive, root, (done, total, verb, name) => {
    if (done < total) {
      console.log(`  [${done + 1}/${total}] ${verb}: ${name}`);
    }
  });

  console.log(`\nCommit complete: ${result.summary}`);
  if (result.errors.length) {
    for (const error of result.errors) {
      console.log(`  ERROR: ${error}`);
    }
  }

  console.log("Saving snapshot...");
  invalidateRemoteCache(root);
  const [remoteState, local] = await Promise.all([
    getRemoteState(drive, config.drive_folder_id || null),
    scanLocal(root),
  ]);
  assertNoDuplicateFolders(remoteState.duplicateFolders);
  writeRemoteCache(root, remoteState, config.drive_folder_id || null);
  writeSnapshot(root, buildSnapshot(remoteState.files, local, message));
  console.log(`Snapshot saved: "${message}"`);
}

function handleLog(options) {
  const root = requireRoot();
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
      .filter((fileName) => fileName.endsWith(".json"))
      .sort()
      .reverse();

    for (const fileName of historyFiles) {
      const fullPath = path.join(historyPath, fileName);
      entries.push(JSON.parse(fs.readFileSync(fullPath, "utf8")));
    }
  }

  if (!entries.length) {
    console.log("No commits yet.");
    return;
  }

  for (const snapshot of entries.slice(0, options.limit || 10)) {
    console.log(
      `  ${snapshot.timestamp || "?"}  ${snapshot.message || "(no message)"}  (${Object.keys(snapshot.files || {}).length} files)`
    );
  }
}

async function handleFetch(options) {
  const root = requireRoot();
  const config = readConfig(root);
  const drive = await getDrive(options);
  const snapshot = readLatestSnapshot(root);

  invalidateRemoteCache(root);
  console.log("Fetching remote file list...");
  const remoteState = await getRemoteState(drive, config.drive_folder_id || null);
  writeRemoteCache(root, remoteState, config.drive_folder_id || null);
  assertNoDuplicateFolders(remoteState.duplicateFolders);
  const remote = remoteState.files;
  console.log(`Found ${remote.length} file(s) on Drive.`);

  // Show what changed on remote since last snapshot
  if (snapshot) {
    const local = await scanLocal(root);
    const diff = computeDiff(snapshot, remote, local, { root });
    const remoteChanges = diff.remoteChanges;
    const conflicts = diff.conflicts;

    if (remoteChanges.length === 0 && conflicts.length === 0) {
      console.log("\nRemote is up to date with last snapshot.");
    } else {
      if (remoteChanges.length) {
        console.log(`\nRemote changes since last commit (${remoteChanges.length}):`);
        for (const c of remoteChanges) {
          console.log(`  ${c.shortStatus} ${c.path}  (${c.description})`);
        }
      }
      if (conflicts.length) {
        console.log(`\nConflicts detected (${conflicts.length}):`);
        for (const c of conflicts) {
          console.log(`  ${c.shortStatus} ${c.path}  (${c.description})`);
        }
      }
      console.log("\nUse 'aethel pull' to apply remote changes, or 'aethel resolve' for conflicts.");
    }
  } else {
    console.log("\nNo snapshot yet. Use 'aethel pull --all' or 'aethel add --all && aethel commit' to create initial snapshot.");
  }
}

async function handlePull(paths, options) {
  const root = requireRoot();
  const { diff } = await loadWorkspaceState(root, options, { useCache: false });

  let remoteChanges = diff.changes.filter((change) =>
    [
      ChangeType.REMOTE_ADDED,
      ChangeType.REMOTE_MODIFIED,
      ChangeType.REMOTE_DELETED,
    ].includes(change.changeType)
  );

  // Include conflicts resolved as "theirs" when --force is set
  if (options.force) {
    const conflicts = diff.conflicts;
    if (conflicts.length) {
      console.log(`Force-pulling ${conflicts.length} conflict(s) (remote wins)...`);
      for (const c of conflicts) {
        stageConflictResolution(root, c, "theirs");
      }
    }
  }

  // Filter to specific paths if provided
  if (paths && paths.length > 0) {
    remoteChanges = remoteChanges.filter((change) =>
      paths.some((p) => matchesPattern(change.path, p))
    );
  }

  if (!remoteChanges.length && !options.force) {
    console.log("Already up to date.");
    if (diff.conflicts.length) {
      console.log(`  (${diff.conflicts.length} conflict(s) exist — use --force to accept remote versions)`);
    }
    return;
  }

  if (options.dryRun) {
    console.log(`Would pull ${remoteChanges.length} change(s):`);
    for (const c of remoteChanges) {
      console.log(`  ${c.shortStatus} ${c.path}  (${c.description})`);
    }
    return;
  }

  const count = stageChanges(root, remoteChanges);
  console.log(`Staged ${count} remote change(s). Committing...`);
  await handleCommit({ ...options, message: options.message || "pull" });
}

async function handlePush(paths, options) {
  const root = requireRoot();
  const { diff } = await loadWorkspaceState(root, options, { useCache: false });

  let localChanges = diff.changes.filter((change) =>
    [
      ChangeType.LOCAL_ADDED,
      ChangeType.LOCAL_MODIFIED,
      ChangeType.LOCAL_DELETED,
    ].includes(change.changeType)
  );

  // Include conflicts resolved as "ours" when --force is set
  if (options.force) {
    const conflicts = diff.conflicts;
    if (conflicts.length) {
      console.log(`Force-pushing ${conflicts.length} conflict(s) (local wins)...`);
      for (const c of conflicts) {
        stageConflictResolution(root, c, "ours");
      }
    }
  }

  // Filter to specific paths if provided
  if (paths && paths.length > 0) {
    localChanges = localChanges.filter((change) =>
      paths.some((p) => matchesPattern(change.path, p))
    );
  }

  if (!localChanges.length && !options.force) {
    console.log("Nothing to push.");
    if (diff.conflicts.length) {
      console.log(`  (${diff.conflicts.length} conflict(s) exist — use --force to push local versions)`);
    }
    return;
  }

  if (options.dryRun) {
    console.log(`Would push ${localChanges.length} change(s):`);
    for (const c of localChanges) {
      console.log(`  ${c.shortStatus} ${c.path}  (${c.description})`);
    }
    return;
  }

  const count = stageChanges(root, localChanges);
  console.log(`Staged ${count} local change(s). Committing...`);
  await handleCommit({ ...options, message: options.message || "push" });
}

async function handleResolve(paths, options) {
  const root = requireRoot();
  const { diff } = await loadWorkspaceState(root, options);
  const conflicts = diff.conflicts;

  if (conflicts.length === 0) {
    console.log("No conflicts to resolve.");
    return;
  }

  // Determine strategy
  const strategy = options.ours ? "ours" : options.theirs ? "theirs" : options.both ? "both" : null;

  if (!strategy) {
    console.log(`Conflicts (${conflicts.length}):`);
    for (const c of conflicts) {
      printChangeDetail(c);
    }
    console.log("\nResolve with:");
    console.log("  aethel resolve --ours [paths...]     Keep local version (upload)");
    console.log("  aethel resolve --theirs [paths...]   Keep remote version (download)");
    console.log("  aethel resolve --both [paths...]     Keep both (remote saved as .remote copy)");
    return;
  }

  // Filter to specific paths or resolve all
  let toResolve = conflicts;
  if (paths && paths.length > 0) {
    toResolve = conflicts.filter((c) =>
      paths.some((p) => matchesPattern(c.path, p))
    );

    if (toResolve.length === 0) {
      console.log("No conflicts match the given path(s).");
      console.log("Current conflicts:");
      for (const c of conflicts) {
        console.log(`  ${c.shortStatus} ${c.path}`);
      }
      return;
    }
  }

  const strategyLabel = { ours: "local wins", theirs: "remote wins", both: "keep both" };

  for (const conflict of toResolve) {
    stageConflictResolution(root, conflict, strategy);
    console.log(`  Resolved: ${conflict.path} → ${strategyLabel[strategy]}`);
  }

  console.log(`\nResolved ${toResolve.length} conflict(s) with strategy: ${strategyLabel[strategy]}`);
  console.log("Run 'aethel commit' to apply.");
}

function handleIgnore(subcommand, args) {
  const root = requireRoot();
  const rules = loadIgnoreRules(root);

  if (subcommand === "list") {
    if (rules.userPatterns.length === 0) {
      console.log("No user-defined ignore patterns (.aethelignore is empty or missing).");
    } else {
      console.log("User-defined patterns:");
      for (const p of rules.userPatterns) {
        console.log(`  ${p}`);
      }
    }
    console.log("\nBuiltin patterns (always ignored):");
    for (const p of [".aethel", ".git", "node_modules", ".DS_Store", "Thumbs.db"]) {
      console.log(`  ${p}`);
    }
    return;
  }

  if (subcommand === "test") {
    for (const testPath of args) {
      const ignored = rules.ignores(testPath);
      console.log(`  ${ignored ? "ignored" : "tracked"}  ${testPath}`);
    }
    return;
  }

  if (subcommand === "create") {
    const created = createDefaultIgnoreFile(root);
    if (created) {
      console.log("Created .aethelignore with default patterns.");
    } else {
      console.log(".aethelignore already exists.");
    }
    return;
  }

  console.log("Usage: aethel ignore <list|test|create> [paths...]");
}

function handleShow(ref, options) {
  const root = requireRoot();
  const snapshotsPath = path.join(root, AETHEL_DIR, SNAPSHOTS_DIR);

  let snapshot;

  if (!ref || ref === "HEAD" || ref === "latest") {
    snapshot = readLatestSnapshot(root);
    if (!snapshot) {
      console.log("No commits yet.");
      return;
    }
  } else {
    // Try to match a history file by prefix
    const historyPath = path.join(snapshotsPath, HISTORY_DIR);
    if (!fs.existsSync(historyPath)) {
      console.log("No commit history found.");
      return;
    }
    const files = fs.readdirSync(historyPath).filter((f) => f.endsWith(".json")).sort().reverse();
    const match = files.find((f) => f.startsWith(ref));
    if (!match) {
      console.log(`No snapshot matching '${ref}' found.`);
      console.log("Available snapshots:");
      for (const f of files.slice(0, 10)) {
        console.log(`  ${f.replace(".json", "")}`);
      }
      return;
    }
    snapshot = JSON.parse(fs.readFileSync(path.join(historyPath, match), "utf-8"));
  }

  console.log(`Snapshot: ${snapshot.timestamp || "?"}`);
  console.log(`Message:  ${snapshot.message || "(no message)"}`);

  const remoteFiles = Object.values(snapshot.files || {});
  const localFiles = Object.keys(snapshot.localFiles || {});

  console.log(`\nRemote files (${remoteFiles.length}):`);
  if (options.verbose) {
    for (const f of remoteFiles) {
      const md5 = f.md5Checksum ? f.md5Checksum.slice(0, 8) : "--------";
      console.log(`  ${md5}  ${f.path || f.name}`);
    }
  } else {
    for (const f of remoteFiles.slice(0, 20)) {
      console.log(`  ${f.path || f.name}`);
    }
    if (remoteFiles.length > 20) {
      console.log(`  ... and ${remoteFiles.length - 20} more`);
    }
  }

  console.log(`\nLocal files (${localFiles.length}):`);
  if (options.verbose) {
    for (const p of localFiles) {
      const meta = snapshot.localFiles[p];
      const md5 = meta.md5 ? meta.md5.slice(0, 8) : "--------";
      console.log(`  ${md5}  ${p}`);
    }
  } else {
    for (const p of localFiles.slice(0, 20)) {
      console.log(`  ${p}`);
    }
    if (localFiles.length > 20) {
      console.log(`  ... and ${localFiles.length - 20} more`);
    }
  }
}

async function handleRestore(paths, options) {
  const root = requireRoot();
  const config = readConfig(root);
  const snapshot = readLatestSnapshot(root);

  if (!snapshot) {
    console.log("No snapshot to restore from. Run 'aethel commit' first.");
    return;
  }

  const drive = await getDrive(options);
  const remoteFiles = snapshot.files || {};

  for (const targetPath of paths) {
    // Find the file in the snapshot by path
    const entry = Object.values(remoteFiles).find(
      (f) => f.path === targetPath || f.localPath === targetPath
    );

    if (!entry) {
      console.log(`  Not found in snapshot: ${targetPath}`);
      continue;
    }

    const localDest = path.join(root, entry.localPath || entry.path);
    console.log(`  Restoring ${targetPath} from Drive...`);

    try {
      const meta = await drive.files.get({
        fileId: entry.id,
        fields: "id,name,mimeType",
      });

      const { downloadFile } = await import("./core/drive-api.js");
      await downloadFile(drive, { ...meta.data, id: entry.id }, localDest);
      console.log(`  Restored: ${targetPath}`);
    } catch (err) {
      console.log(`  Failed to restore ${targetPath}: ${err.message}`);
    }
  }
}

async function handleRm(paths, options) {
  const root = requireRoot();
  const { diff } = await loadWorkspaceState(root, options);

  for (const targetPath of paths) {
    // Delete locally
    const localAbs = path.join(root, targetPath);
    if (fs.existsSync(localAbs)) {
      await fs.promises.rm(localAbs, { recursive: true });
      console.log(`  Deleted locally: ${targetPath}`);
    }

    // If it exists on remote, stage a delete_remote
    const remoteChange = diff.changes.find(
      (c) => c.path === targetPath && c.fileId
    );
    if (remoteChange) {
      stageChange(root, {
        ...remoteChange,
        changeType: ChangeType.LOCAL_DELETED,
        suggestedAction: "delete_remote",
      });
      console.log(`  Staged remote deletion: ${targetPath}`);
    } else {
      // After local delete, rescan will pick it up as local_deleted
      console.log(`  Removed: ${targetPath} (re-run 'aethel status' to see changes)`);
    }
  }
}

async function handleMv(source, dest, options) {
  const root = requireRoot();

  const srcAbs = path.join(root, source);
  const destAbs = path.join(root, dest);

  if (!fs.existsSync(srcAbs)) {
    console.log(`Source not found: ${source}`);
    return;
  }

  // Ensure destination directory exists
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  await fs.promises.rename(srcAbs, destAbs);
  console.log(`  Moved: ${source} → ${dest}`);
  console.log("  Run 'aethel status' to see the resulting changes (old path deleted, new path added).");
}

async function handleTui(options) {
  const drive = await getDrive(options);
  const cliArgs = [];
  if (options.credentials) {
    cliArgs.push("--credentials", options.credentials);
  }
  if (options.token) {
    cliArgs.push("--token", options.token);
  }
  await runTui({
    drive,
    includeSharedDrives: Boolean(options.sharedDrives),
    cliPath: path.resolve(process.argv[1]),
    cliArgs,
  });
}

function printDedupeSummary(result) {
  for (const group of result.duplicateFolders) {
    console.log(
      `- ${group.path} | canonical=${group.canonical.id} | duplicates=${group.folders.length}`
    );
  }
  console.log(`Duplicate paths: ${result.duplicatePaths}`);
  console.log(`Moved items: ${result.movedItems}`);
  console.log(`Trashed duplicate files: ${result.trashedDuplicateFiles}`);
  console.log(`Trashed folders: ${result.trashedFolders}`);
  console.log(`Skipped conflicts: ${result.skippedConflicts}`);
  console.log(`Remaining duplicate paths: ${result.remainingDuplicateFolders.length}`);
}

async function handleDedupeFolders(options) {
  const root = requireRoot();
  const config = readConfig(root);
  const drive = await getDrive(options);
  const rootFolderId = config.drive_folder_id || null;
  const ignoreRules = loadIgnoreRules(root);
  const result = await dedupeDuplicateFolders(drive, rootFolderId, {
    execute: Boolean(options.execute),
    ignoreRules,
    onProgress: (event) => {
      if (!options.execute) {
        return;
      }

      if (event.type === "move") {
        console.log(`  moved ${event.itemType}: ${event.path}`);
        return;
      }

      if (event.type === "trash_duplicate_file") {
        console.log(`  trashed duplicate file: ${event.path}`);
        return;
      }

      if (event.type === "trash_folder") {
        console.log(`  trashed folder: ${event.path}`);
        return;
      }

      if (event.type === "skip_conflict") {
        console.log(`  skipped conflict: ${event.path}`);
      }
    },
  });

  if (result.duplicateFolders.length === 0) {
    console.log("No duplicate folders detected.");
    return;
  }

  console.log(options.execute ? "Execution summary:" : "Dry run summary:");
  printDedupeSummary(result);

  if (options.execute) {
    invalidateRemoteCache(root);
    if (result.remainingDuplicateFolders.length > 0) {
      throw new DuplicateFoldersError(result.remainingDuplicateFolders);
    }
  }
}

async function main() {
  const program = new Command();

  program
    .name("aethel")
    .description("Git-like Google Drive sync management and cleanup")
    .showHelpAfterError();

  addAuthOptions(
    program
      .command("auth")
      .description("Run OAuth initialization and verify Google Drive access")
  ).action(handleAuth);

  addAuthOptions(
    program
      .command("clean")
      .description("List accessible Drive files and optionally trash or delete them")
      .option("--shared-drives", "Include shared drives")
      .option("--permanent", "Permanently delete files instead of moving them to trash")
      .option("--execute", "Execute the selected operation")
      .option("--confirm <phrase>", "Confirmation phrase required for --execute", "")
  ).action(handleClean);

  program
    .command("init")
    .description("Initialise a sync workspace")
    .option("--local-path <path>", "Local directory to sync", ".")
    .option("--drive-folder <id>", "Drive folder ID to sync")
    .option("--drive-folder-name <name>", "Display name for the Drive folder")
    .action(handleInit);

  addAuthOptions(
    program
      .command("status")
      .description("Show sync status")
      .option("-v, --verbose", "Show additional details like synced packs")
  ).action(handleStatus);

  addAuthOptions(
    program
      .command("diff")
      .description("Show detailed changes")
      .option("--side <side>", "Which side to show: remote, local, or all", "all")
  ).action(handleDiff);

  addAuthOptions(
    program
      .command("add")
      .description("Stage changes for commit")
      .argument("[paths...]", "Paths or glob patterns to stage")
      .option("--all, -a", "Stage all changes")
  ).action((paths, options) => handleAdd(paths, options));

  program
    .command("reset")
    .description("Unstage changes")
    .argument("[paths...]", "Paths to unstage")
    .option("--all", "Unstage everything")
    .action((paths, options) => handleReset(paths, options));

  addAuthOptions(
    program
      .command("commit")
      .description("Apply staged changes and save snapshot")
      .option("-m, --message <message>", "Commit message")
  ).action(handleCommit);

  program
    .command("log")
    .description("Show commit history")
    .option("-n, --limit <number>", "Number of entries to show", Number, 10)
    .action(handleLog);

  addAuthOptions(program.command("fetch").description("Check remote state")).action(
    handleFetch
  );

  addAuthOptions(
    program
      .command("dedupe-folders")
      .description("Detect and optionally remediate duplicate remote folders")
      .option("--execute", "Move items and trash empty duplicate folders")
  ).action(handleDedupeFolders);

  addAuthOptions(
    program
      .command("pull")
      .description("Download remote changes")
      .argument("[paths...]", "Specific paths to pull (default: all)")
      .option("-m, --message <message>", "Commit message")
      .option("--force", "Force-pull conflicts (remote wins)")
      .option("--dry-run", "Preview changes without applying")
  ).action((paths, options) => handlePull(paths, options));

  addAuthOptions(
    program
      .command("push")
      .description("Upload local changes")
      .argument("[paths...]", "Specific paths to push (default: all)")
      .option("-m, --message <message>", "Commit message")
      .option("--force", "Force-push conflicts (local wins)")
      .option("--dry-run", "Preview changes without applying")
  ).action((paths, options) => handlePush(paths, options));

  addAuthOptions(
    program
      .command("resolve")
      .description("Resolve file conflicts")
      .argument("[paths...]", "Conflicted paths to resolve (default: all)")
      .option("--ours", "Keep local version (upload to Drive)")
      .option("--theirs", "Keep remote version (download from Drive)")
      .option("--both", "Keep both versions (remote saved as .remote copy)")
  ).action((paths, options) => handleResolve(paths, options));

  program
    .command("ignore")
    .description("Manage .aethelignore patterns")
    .argument("<subcommand>", "list, test, or create")
    .argument("[paths...]", "Paths to test (for 'test' subcommand)")
    .action((subcommand, paths) => handleIgnore(subcommand, paths));

  program
    .command("show")
    .description("Show details of a commit/snapshot")
    .argument("[ref]", "Snapshot reference (HEAD, latest, or timestamp prefix)", "HEAD")
    .option("-v, --verbose", "Show all files with checksums")
    .action((ref, options) => handleShow(ref, options));

  addAuthOptions(
    program
      .command("restore")
      .description("Restore file(s) from the last snapshot")
      .argument("<paths...>", "Paths to restore")
  ).action((paths, options) => handleRestore(paths, options));

  addAuthOptions(
    program
      .command("rm")
      .description("Delete file(s) locally and stage remote deletion")
      .argument("<paths...>", "Paths to remove")
  ).action((paths, options) => handleRm(paths, options));

  program
    .command("mv")
    .description("Move/rename a file locally")
    .argument("<source>", "Source path (relative to workspace)")
    .argument("<dest>", "Destination path (relative to workspace)")
    .action((source, dest, options) => handleMv(source, dest, options));

  addAuthOptions(
    program
      .command("tui")
      .description("Launch the interactive Ink terminal UI")
      .option("--shared-drives", "Include shared drives")
  ).action(handleTui);

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error ?? "Unknown error");
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
