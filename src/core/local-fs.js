import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { humanSize } from "./drive-api.js";
import { loadIgnoreRules } from "./ignore.js";
import { findRoot } from "./config.js";

export function defaultLocalRoot() {
  return process.cwd() || os.homedir();
}

export async function ensureLocalDirectory(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  const stat = await fs.promises.stat(resolvedPath);

  if (!stat.isDirectory()) {
    throw new Error(`Local path is not a directory: ${resolvedPath}`);
  }

  return resolvedPath;
}

export async function listLocalEntries(targetPath, { respectIgnore = true } = {}) {
  const resolvedPath = await ensureLocalDirectory(targetPath);

  // Load ignore rules if inside an Aethel workspace
  let ignoreRules = null;
  if (respectIgnore) {
    const root = findRoot(resolvedPath);
    if (root) {
      ignoreRules = loadIgnoreRules(root);
    }
  }

  const directoryEntries = await fs.promises.readdir(resolvedPath, {
    withFileTypes: true,
  });

  // Resolve root once, outside the filter — not per-entry
  const workspaceRoot = respectIgnore ? findRoot(resolvedPath) : null;

  const items = await Promise.all(
    directoryEntries
      .filter((entry) => {
        if (entry.name.startsWith(".")) return false;
        if (ignoreRules && workspaceRoot) {
          const rel = path.relative(workspaceRoot, path.join(resolvedPath, entry.name)).split(path.sep).join("/");
          if (ignoreRules.ignores(rel)) return false;
        }
        return true;
      })
      .map(async (entry) => {
        const absolutePath = path.join(resolvedPath, entry.name);
        const stat = await fs.promises.stat(absolutePath);

        return {
          id: absolutePath,
          name: entry.name,
          absolutePath,
          isDirectory: stat.isDirectory(),
          size: stat.isDirectory() ? null : stat.size,
          sizeLabel: stat.isDirectory() ? " DIR  " : humanSize(stat.size),
          modifiedTime: new Date(stat.mtimeMs).toISOString(),
        };
      })
  );

  return items.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export async function deleteLocalEntry(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  await fs.promises.rm(resolvedPath, { recursive: true, force: false });
  return resolvedPath;
}

export async function renameLocalEntry(targetPath, nextName) {
  const resolvedPath = path.resolve(targetPath);
  const trimmedName = nextName.trim();

  if (!trimmedName) {
    throw new Error("New name cannot be empty.");
  }

  if (trimmedName.includes(path.sep)) {
    throw new Error("New name cannot include path separators.");
  }

  const nextPath = path.join(path.dirname(resolvedPath), trimmedName);
  if (resolvedPath === nextPath) {
    return resolvedPath;
  }

  await fs.promises.access(nextPath).then(
    () => {
      throw new Error(`Target already exists: ${nextPath}`);
    },
    () => undefined
  );

  await fs.promises.rename(resolvedPath, nextPath);
  return nextPath;
}
