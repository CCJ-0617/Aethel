import path from "node:path";
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
  batchOperateFiles,
  getAccountInfo,
  humanSize,
  iconForMime,
  listAccessibleFiles,
  sourceBadgeForItem,
  syncLocalDirectoryToParent,
  uploadLocalEntry,
} from "../core/drive-api.js";
import {
  defaultLocalRoot,
  deleteLocalEntry,
  ensureLocalDirectory,
  listLocalEntries,
  renameLocalEntry,
} from "../core/local-fs.js";

const h = React.createElement;

function truncate(value, width) {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

function scrollWindow(length, cursor, height) {
  return Math.min(
    Math.max(cursor - Math.floor(height / 2), 0),
    Math.max(length - height, 0)
  );
}

function renderRemoteRow(file, isCursor, isSelected, width) {
  const mark = isSelected ? "[x]" : "[ ]";
  const sourceBadge = sourceBadgeForItem(file);
  const icon = iconForMime(file.mimeType || "");
  const size = humanSize(file.size);
  const line = truncate(
    `${mark} ${sourceBadge} ${icon} ${size}  ${file.name}`,
    width
  );

  return h(
    Text,
    {
      key: file.id,
      inverse: isCursor,
      color: isSelected ? "cyan" : undefined,
      bold: isSelected,
      wrap: "truncate-end",
    },
    line
  );
}

function renderLocalRow(entry, isCursor, width) {
  const icon = entry.isDirectory ? "[DIR]" : "[FIL]";
  const line = truncate(`[LOC] ${icon} ${entry.sizeLabel}  ${entry.name}`, width);

  return h(
    Text,
    {
      key: entry.id,
      inverse: isCursor,
      color: entry.isDirectory ? "green" : undefined,
      bold: entry.isDirectory,
      wrap: "truncate-end",
    },
    line
  );
}

function renderPane({
  title,
  breadcrumb,
  focused,
  entries,
  cursor,
  renderer,
  width,
  height,
  emptyMessage,
}) {
  const bodyHeight = Math.max(height - 3, 1);
  const start = scrollWindow(entries.length, cursor, bodyHeight);
  const visibleEntries = entries.slice(start, start + bodyHeight);

  return h(
    Box,
    {
      width,
      flexDirection: "column",
      paddingRight: 1,
    },
    h(
      Text,
      {
        bold: true,
        color: focused ? "cyan" : "white",
      },
      truncate(`${focused ? ">" : " "} ${title}`, width)
    ),
    h(Text, { dimColor: true }, truncate(breadcrumb, width)),
    ...(visibleEntries.length
      ? visibleEntries.map((entry, index) =>
          renderer(entry, start + index === cursor, width)
        )
      : [
          h(
            Text,
            { key: `${title}-empty`, dimColor: true },
            truncate(emptyMessage, width)
          ),
        ])
  );
}

function renderHelp() {
  return h(
    Box,
    {
      borderStyle: "round",
      borderColor: "cyan",
      paddingX: 1,
      marginTop: 1,
      flexDirection: "column",
    },
    h(Text, { bold: true }, "Aethel TUI - Keyboard Shortcuts"),
    h(Text, null, "Tab            Switch focus between Drive and Local panes"),
    h(Text, null, "Up/Down, j/k   Navigate the focused pane"),
    h(Text, null, "Left/Right     Move to parent or enter directory in focused pane"),
    h(Text, null, "u              Upload selected local entry to current Drive directory"),
    h(Text, null, "s              Sync selected local directory contents to current Drive directory"),
    h(Text, null, "n              Rename selected local file or directory"),
    h(Text, null, "x              Delete selected local file or directory"),
    h(Text, null, "Space          Toggle Drive selection in Drive pane"),
    h(Text, null, "t / d          Trash or permanently delete selected Drive items"),
    h(Text, null, "/              Filter the focused pane"),
    h(Text, null, "U              Manually enter a local path and upload"),
    h(Text, null, "r              Reload Drive and Local panes"),
    h(Text, null, "q              Quit"),
    h(Text, { dimColor: true }, "Press any key to close this help.")
  );
}

export function AethelTui({ drive, includeSharedDrives = false }) {
  const { exit } = useApp();
  const [mode, setMode] = useState("loading");
  const [remoteLoading, setRemoteLoading] = useState(true);
  const [focusPane, setFocusPane] = useState("local");
  const [account, setAccount] = useState(null);
  const [remoteFiles, setRemoteFiles] = useState([]);
  const [remoteFolderStack, setRemoteFolderStack] = useState([]);
  const [localRoot] = useState(defaultLocalRoot);
  const [localDirectory, setLocalDirectory] = useState(defaultLocalRoot);
  const [localEntries, setLocalEntries] = useState([]);
  const [remoteFilter, setRemoteFilter] = useState("");
  const [localFilter, setLocalFilter] = useState("");
  const [remoteCursor, setRemoteCursor] = useState(0);
  const [localCursor, setLocalCursor] = useState(0);
  const [selectedRemoteIds, setSelectedRemoteIds] = useState(() => new Set());
  const [status, setStatus] = useState("Loading account info...");
  const [errorMessage, setErrorMessage] = useState("");
  const [pendingAction, setPendingAction] = useState(null);
  const [inputValue, setInputValue] = useState("");
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const currentRemoteFolderId = remoteFolderStack.length
    ? remoteFolderStack[remoteFolderStack.length - 1].id
    : null;
  const currentUploadParentId = currentRemoteFolderId || "root";

  const remoteFolderIds = useMemo(
    () =>
      new Set(
        remoteFiles.filter((file) => file.isFolder).map((file) => file.id)
      ),
    [remoteFiles]
  );

  const currentRemoteDirectoryEntries = useMemo(() => {
    const entries = remoteFiles.filter((file) => {
      if (!currentRemoteFolderId) {
        return (
          file.isRootLevel ||
          !file.parentId ||
          !remoteFolderIds.has(file.parentId)
        );
      }

      return file.parentId === currentRemoteFolderId;
    });

    return entries.sort((left, right) => {
      if (left.isFolder !== right.isFolder) {
        return left.isFolder ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
  }, [currentRemoteFolderId, remoteFiles, remoteFolderIds]);

  const filteredRemoteEntries = useMemo(() => {
    const query = remoteFilter.trim().toLowerCase();
    if (!query) {
      return currentRemoteDirectoryEntries;
    }

    return currentRemoteDirectoryEntries.filter((file) =>
      file.name.toLowerCase().includes(query)
    );
  }, [currentRemoteDirectoryEntries, remoteFilter]);

  const filteredLocalEntries = useMemo(() => {
    const query = localFilter.trim().toLowerCase();
    if (!query) {
      return localEntries;
    }

    return localEntries.filter((entry) =>
      entry.name.toLowerCase().includes(query)
    );
  }, [localEntries, localFilter]);

  const currentLocalEntry = filteredLocalEntries[localCursor] || null;
  const currentRemoteEntry = filteredRemoteEntries[remoteCursor] || null;
  const currentRemoteFolderMeta = currentRemoteFolderId
    ? remoteFiles.find((file) => file.id === currentRemoteFolderId) || null
    : null;
  const currentRemoteFolderWritable =
    !currentRemoteFolderMeta ||
    currentRemoteFolderMeta.capabilities?.canAddChildren !== false;

  useEffect(() => {
    setRemoteCursor((current) =>
      Math.min(current, Math.max(filteredRemoteEntries.length - 1, 0))
    );
  }, [filteredRemoteEntries.length]);

  useEffect(() => {
    setLocalCursor((current) =>
      Math.min(current, Math.max(filteredLocalEntries.length - 1, 0))
    );
  }, [filteredLocalEntries.length]);

  async function loadLocalPane(nextDirectory = localDirectory) {
    const resolvedDirectory = await ensureLocalDirectory(nextDirectory);
    const items = await listLocalEntries(resolvedDirectory);
    setLocalDirectory(resolvedDirectory);
    setLocalEntries(items);
    setLocalCursor(0);
  }

  async function loadAllData(nextStatus = "", preserveRemoteFolder = false) {
    const nextRemoteFolderStack = preserveRemoteFolder ? [...remoteFolderStack] : [];
    setRemoteLoading(true);

    // Load local pane immediately — it's instant (disk I/O only)
    try {
      await loadLocalPane(localDirectory);
      // Switch to normal mode so the user can browse local files while remote loads
      setMode("normal");
      setStatus("Loading Drive files...");
    } catch (error) {
      setErrorMessage(error.message);
      setMode("error");
      return;
    }

    // Fetch remote in background
    try {
      const [nextAccount, nextRemoteFiles] = await Promise.all([
        getAccountInfo(drive),
        listAccessibleFiles(drive, includeSharedDrives),
      ]);

      setAccount(nextAccount);
      setRemoteFiles(nextRemoteFiles);
      setRemoteFolderStack(nextRemoteFolderStack);
      setSelectedRemoteIds(new Set());
      setRemoteLoading(false);
      setStatus(
        nextStatus || `Loaded ${nextRemoteFiles.length} Drive item(s). Press ? for help.`
      );
    } catch (error) {
      setRemoteLoading(false);
      setStatus(`Drive load failed: ${error.message}. Local pane is still usable.`);
    }
  }

  useEffect(() => {
    void loadAllData();
  }, []);

  async function executeRemoteDelete(permanent) {
    const targets = remoteFiles.filter((file) => selectedRemoteIds.has(file.id));
    if (targets.length === 0) {
      setStatus("No Drive items selected.");
      return;
    }

    setMode("busy");
    try {
      const result = await batchOperateFiles(drive, targets, {
        permanent,
        includeSharedDrives,
        onProgress: (done, total, verb, name) => {
          setStatus(`[${done}/${total}] ${verb}: ${name}`);
        },
      });

      await loadAllData(
        `Done: ${result.success} succeeded, ${result.errors} failed.`,
        true
      );
    } catch (error) {
      setErrorMessage(error.message);
      setMode("error");
    }
  }

  async function executeUpload(targetPath) {
    const trimmedPath = targetPath.trim();
    if (!trimmedPath) {
      setMode("normal");
      setStatus("Upload cancelled.");
      return;
    }

    setMode("busy");
    try {
      const result = await uploadLocalEntry(
        drive,
        trimmedPath,
        currentUploadParentId,
        (verb, localPath, name) => {
          if (verb === "mkdir") {
            setStatus(`Creating remote directory: ${name}`);
            return;
          }
          setStatus(`Uploading: ${name} (${localPath})`);
        }
      );

      setInputValue("");
      await loadAllData(
        `Uploaded ${result.uploadedFiles} file(s) and ${result.uploadedDirectories} director${result.uploadedDirectories === 1 ? "y" : "ies"}.`,
        true
      );
    } catch (error) {
      setMode("normal");
      setStatus(`Upload failed: ${error.message}`);
    }
  }

  async function executeSyncDirectory(targetPath) {
    setMode("busy");
    try {
      const result = await syncLocalDirectoryToParent(
        drive,
        targetPath,
        currentUploadParentId,
        (verb, localPath, name) => {
          if (verb === "mkdir") {
            setStatus(`Sync mkdir: ${name}`);
            return;
          }
          setStatus(`Sync upload: ${name} (${localPath})`);
        }
      );

      await loadAllData(
        `Synced ${result.uploadedFiles} file(s) and ${result.uploadedDirectories} director${result.uploadedDirectories === 1 ? "y" : "ies"} into current Drive directory.`,
        true
      );
    } catch (error) {
      setMode("normal");
      setStatus(`Sync failed: ${error.message}`);
    }
  }

  async function executeLocalDelete(targetPath) {
    setMode("busy");
    try {
      await deleteLocalEntry(targetPath);
      await loadLocalPane(path.dirname(targetPath) === targetPath ? localDirectory : localDirectory);
      setMode("normal");
      setStatus(`Deleted local entry: ${path.basename(targetPath)}`);
    } catch (error) {
      setMode("normal");
      setStatus(`Local delete failed: ${error.message}`);
    }
  }

  async function executeLocalRename(targetPath, nextName) {
    setMode("busy");
    try {
      const renamedPath = await renameLocalEntry(targetPath, nextName);
      await loadLocalPane(path.dirname(renamedPath));
      setMode("normal");
      setStatus(`Renamed local entry to: ${path.basename(renamedPath)}`);
    } catch (error) {
      setMode("normal");
      setStatus(`Local rename failed: ${error.message}`);
    }
  }

  async function openLocalDirectory(nextPath) {
    try {
      await loadLocalPane(nextPath);
      setLocalFilter("");
      setStatus(`Opened local directory: ${path.basename(nextPath) || nextPath}`);
    } catch (error) {
      setStatus(`Local directory error: ${error.message}`);
    }
  }

  function switchFocus() {
    setFocusPane((current) => (current === "local" ? "remote" : "local"));
    setStatus(
      focusPane === "local"
        ? "Switched focus to Drive pane."
        : "Switched focus to Local pane."
    );
  }

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || (mode === "error" && input === "q")) {
      exit();
      return;
    }

    if (mode === "loading" || mode === "busy") {
      return;
    }

    if (mode === "error") {
      if (key.escape || input === "q" || input === "Q") {
        exit();
      }
      return;
    }

    if (mode === "help") {
      setMode("normal");
      return;
    }

    if (mode === "confirm") {
      if (input === "y" || input === "Y") {
        const action = pendingAction;
        setPendingAction(null);
        if (!action) {
          setMode("normal");
          return;
        }

        if (action.type === "remote-trash") {
          void executeRemoteDelete(false);
          return;
        }

        if (action.type === "remote-delete") {
          void executeRemoteDelete(true);
          return;
        }

        if (action.type === "local-delete") {
          void executeLocalDelete(action.targetPath);
          return;
        }

        if (action.type === "local-sync") {
          void executeSyncDirectory(action.targetPath);
          return;
        }
      }

      if (input === "n" || input === "N" || key.escape) {
        setPendingAction(null);
        setMode("normal");
        setStatus("Cancelled.");
      }
      return;
    }

    if (mode === "filter") {
      if (key.escape) {
        if (focusPane === "local") {
          setLocalFilter("");
        } else {
          setRemoteFilter("");
        }
        setMode("normal");
        setStatus("Filter cleared.");
        return;
      }

      if (key.return) {
        setMode("normal");
        setStatus("Filter applied.");
        return;
      }

      if (key.backspace || input === "\u007f") {
        if (focusPane === "local") {
          setLocalFilter((current) => current.slice(0, -1));
        } else {
          setRemoteFilter((current) => current.slice(0, -1));
        }
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        if (focusPane === "local") {
          setLocalFilter((current) => current + input);
        } else {
          setRemoteFilter((current) => current + input);
        }
      }
      return;
    }

    if (mode === "upload") {
      if (key.escape) {
        setInputValue("");
        setMode("normal");
        setStatus("Manual upload cancelled.");
      }
      return;
    }

    if (mode === "rename") {
      if (key.escape) {
        setInputValue("");
        setPendingAction(null);
        setMode("normal");
        setStatus("Rename cancelled.");
      }
      return;
    }

    if (input === "q" || input === "Q") {
      exit();
      return;
    }

    if (key.tab || input === "\t") {
      switchFocus();
      return;
    }

    if (input === "?") {
      setMode("help");
      return;
    }

    if (input === "/") {
      setMode("filter");
      setStatus(`Type to filter the ${focusPane} pane.`);
      return;
    }

    if (input === "r" || input === "R") {
      void loadAllData("Reloaded Drive and Local panes.", true);
      return;
    }

    if (key.upArrow || input === "k") {
      if (focusPane === "local") {
        setLocalCursor((current) => Math.max(current - 1, 0));
      } else {
        setRemoteCursor((current) => Math.max(current - 1, 0));
      }
      return;
    }

    if (key.downArrow || input === "j") {
      if (focusPane === "local") {
        setLocalCursor((current) =>
          Math.min(current + 1, Math.max(filteredLocalEntries.length - 1, 0))
        );
      } else {
        setRemoteCursor((current) =>
          Math.min(current + 1, Math.max(filteredRemoteEntries.length - 1, 0))
        );
      }
      return;
    }

    if (key.pageUp) {
      const delta = Math.max(height - 13, 1);
      if (focusPane === "local") {
        setLocalCursor((current) => Math.max(current - delta, 0));
      } else {
        setRemoteCursor((current) => Math.max(current - delta, 0));
      }
      return;
    }

    if (key.pageDown) {
      const delta = Math.max(height - 13, 1);
      if (focusPane === "local") {
        setLocalCursor((current) =>
          Math.min(current + delta, Math.max(filteredLocalEntries.length - 1, 0))
        );
      } else {
        setRemoteCursor((current) =>
          Math.min(current + delta, Math.max(filteredRemoteEntries.length - 1, 0))
        );
      }
      return;
    }

    if (key.home) {
      if (focusPane === "local") {
        setLocalCursor(0);
      } else {
        setRemoteCursor(0);
      }
      return;
    }

    if (key.end) {
      if (focusPane === "local") {
        setLocalCursor(Math.max(filteredLocalEntries.length - 1, 0));
      } else {
        setRemoteCursor(Math.max(filteredRemoteEntries.length - 1, 0));
      }
      return;
    }

    if (key.leftArrow) {
      if (focusPane === "local") {
        if (
          localDirectory === localRoot ||
          localDirectory === path.dirname(localDirectory)
        ) {
          setStatus("Already at the local root directory.");
          return;
        }
        void openLocalDirectory(path.dirname(localDirectory));
        return;
      }

      if (remoteFolderStack.length === 0) {
        setStatus("Already at the Drive root directory.");
        return;
      }

      setRemoteFolderStack((current) => current.slice(0, -1));
      setRemoteCursor(0);
      setRemoteFilter("");
      setStatus("Moved to the parent Drive directory.");
      return;
    }

    if (key.rightArrow) {
      if (focusPane === "local") {
        if (!currentLocalEntry) {
          setStatus("No local item is selected.");
          return;
        }

        if (!currentLocalEntry.isDirectory) {
          setStatus("The selected local item is not a directory.");
          return;
        }

        void openLocalDirectory(currentLocalEntry.absolutePath);
        return;
      }

      if (!currentRemoteEntry) {
        setStatus("No Drive item is selected.");
        return;
      }

      if (!currentRemoteEntry.isFolder) {
        setStatus("The selected Drive item is not a directory.");
        return;
      }

      setRemoteFolderStack((current) => [
        ...current,
        { id: currentRemoteEntry.id, name: currentRemoteEntry.name },
      ]);
      setRemoteCursor(0);
      setRemoteFilter("");
      setStatus(`Entered Drive directory: ${currentRemoteEntry.name}`);
      return;
    }

    if (focusPane === "local") {
      if (input === "u" || input === "U") {
        if (!currentLocalEntry) {
          setStatus("No local item is selected.");
          return;
        }
        if (!currentRemoteFolderWritable) {
          setStatus(
            `Cannot upload into current Drive directory${
              currentRemoteFolderMeta?.name ? `: ${currentRemoteFolderMeta.name}` : ""
            }. This folder does not allow adding children.`
          );
          return;
        }
        void executeUpload(currentLocalEntry.absolutePath);
        return;
      }

      if (input === "s" || input === "S") {
        if (!currentLocalEntry) {
          setStatus("No local directory is selected.");
          return;
        }
        if (!currentLocalEntry.isDirectory) {
          setStatus("Batch sync requires a local directory.");
          return;
        }
        if (!currentRemoteFolderWritable) {
          setStatus(
            `Cannot sync into current Drive directory${
              currentRemoteFolderMeta?.name ? `: ${currentRemoteFolderMeta.name}` : ""
            }. This folder does not allow adding children.`
          );
          return;
        }

        setPendingAction({
          type: "local-sync",
          targetPath: currentLocalEntry.absolutePath,
        });
        setMode("confirm");
        setStatus(
          `Press y to sync contents of ${currentLocalEntry.name} into current Drive directory.`
        );
        return;
      }

      if (input === "n" || input === "N") {
        if (!currentLocalEntry) {
          setStatus("No local item is selected.");
          return;
        }

        setPendingAction({
          type: "local-rename",
          targetPath: currentLocalEntry.absolutePath,
        });
        setInputValue(currentLocalEntry.name);
        setMode("rename");
        setStatus(`Enter a new name for ${currentLocalEntry.name}.`);
        return;
      }

      if (input === "x" || input === "X") {
        if (!currentLocalEntry) {
          setStatus("No local item is selected.");
          return;
        }

        setPendingAction({
          type: "local-delete",
          targetPath: currentLocalEntry.absolutePath,
        });
        setMode("confirm");
        setStatus(
          `Press y to delete local ${currentLocalEntry.isDirectory ? "directory" : "file"} ${currentLocalEntry.name}.`
        );
        return;
      }

      return;
    }

    if (input === " ") {
      if (!currentRemoteEntry) {
        return;
      }

      setSelectedRemoteIds((current) => {
        const next = new Set(current);
        if (next.has(currentRemoteEntry.id)) {
          next.delete(currentRemoteEntry.id);
        } else {
          next.add(currentRemoteEntry.id);
        }
        return next;
      });
      return;
    }

    if (input === "a" || input === "A") {
      const visibleIds = filteredRemoteEntries.map((file) => file.id);
      const allVisibleSelected =
        visibleIds.length > 0 && visibleIds.every((id) => selectedRemoteIds.has(id));

      setSelectedRemoteIds((current) => {
        const next = new Set(current);
        if (allVisibleSelected) {
          for (const id of visibleIds) {
            next.delete(id);
          }
        } else {
          for (const id of visibleIds) {
            next.add(id);
          }
        }
        return next;
      });
      setStatus(
        allVisibleSelected
          ? "Deselected all visible Drive items."
          : `Selected ${visibleIds.length} visible Drive item(s).`
      );
      return;
    }

    if (input === "t" || input === "T") {
      if (selectedRemoteIds.size === 0) {
        setStatus("No Drive items selected.");
        return;
      }

      setPendingAction({ type: "remote-trash" });
      setMode("confirm");
      setStatus(`Press y to trash ${selectedRemoteIds.size} Drive item(s).`);
      return;
    }

    if (input === "d" || input === "D") {
      if (selectedRemoteIds.size === 0) {
        setStatus("No Drive items selected.");
        return;
      }

      setPendingAction({ type: "remote-delete" });
      setMode("confirm");
      setStatus(`Press y to permanently delete ${selectedRemoteIds.size} Drive item(s).`);
      return;
    }

    if (input === "U") {
      if (!currentRemoteFolderWritable) {
        setStatus(
          `Cannot upload into current Drive directory${
            currentRemoteFolderMeta?.name ? `: ${currentRemoteFolderMeta.name}` : ""
          }. This folder does not allow adding children.`
        );
        return;
      }
      setInputValue("");
      setMode("upload");
      setStatus("Enter a local file or directory path to upload.");
    }
  });

  const driveBreadcrumb = remoteFolderStack.length
    ? `Drive: /${remoteFolderStack.map((folder) => folder.name).join("/")}`
    : "Drive: /";
  const localBreadcrumb = `Local: ${localDirectory}`;
  const selectedCount = selectedRemoteIds.size;
  const contentHeight = Math.max(height - 10, 6);
  const paneWidth = Math.max(Math.floor((width - 3) / 2), 24);

  if (mode === "error") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { color: "red", bold: true }, "Aethel failed to load."),
      h(Text, null, errorMessage || "Unknown error."),
      h(Text, { dimColor: true }, "Press q or Esc to quit.")
    );
  }

  if (mode === "loading") {
    return h(
      Box,
      { flexDirection: "column" },
      h(
        Text,
        { color: "cyan" },
        h(Spinner, { type: "dots" }),
        ` ${status}`
      )
    );
  }

  let hints =
    "Tab:focus  Left/Right:navigate  u:upload local  s:sync dir  n:rename local  x:delete local  Space:select drive  t/d:delete drive  /:filter  U:manual upload  r:reload  q:quit  ?:help";
  if (mode === "filter") {
    hints = "Enter: apply filter  Esc: cancel";
  } else if (mode === "confirm") {
    hints = "y: confirm  n: cancel";
  } else if (mode === "upload") {
    hints = "Enter: upload path  Esc: cancel";
  } else if (mode === "rename") {
    hints = "Enter: rename  Esc: cancel";
  }

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: "cyan", bold: true }, truncate("Aethel", width)),
    account
      ? h(
          Text,
          null,
          truncate(
            `${account.name} <${account.email}> | ${account.usage} / ${account.limit}`,
            width
          )
        )
      : null,
    h(
      Text,
      { dimColor: true },
      truncate(
        `${driveBreadcrumb} | ${localBreadcrumb}`,
        width
      )
    ),
    h(
      Text,
      { dimColor: true },
      truncate(
        `Legend: [MY ] owned by me  [SHR] shared with me  [DRV] shared drive  [LOC] local item | ${selectedCount} Drive item(s) selected | Upload ${currentRemoteFolderWritable ? "enabled" : "blocked"}`,
        width
      )
    ),
    h(Text, { dimColor: true }, "─".repeat(Math.max(Math.min(width, 80), 10))),
    h(
      Box,
      { flexDirection: "row" },
      renderPane({
        title: "Local",
        breadcrumb: truncate(localDirectory, paneWidth),
        focused: focusPane === "local",
        entries: filteredLocalEntries,
        cursor: localCursor,
        renderer: renderLocalRow,
        width: paneWidth,
        height: contentHeight,
        emptyMessage: localFilter
          ? "No local items match the filter."
          : "No local items found.",
      }),
      h(Text, { dimColor: true }, " | "),
      renderPane({
        title: remoteLoading ? "Drive (loading...)" : "Drive",
        breadcrumb: truncate(
          remoteFolderStack.length
            ? `/${remoteFolderStack.map((folder) => folder.name).join("/")}`
            : "/",
          paneWidth
        ),
        focused: focusPane === "remote",
        entries: filteredRemoteEntries,
        cursor: remoteCursor,
        renderer: (entry, isCursor, itemWidth) =>
          renderRemoteRow(
            entry,
            isCursor,
            selectedRemoteIds.has(entry.id),
            itemWidth
          ),
        width: paneWidth,
        height: contentHeight,
        emptyMessage: remoteFilter
          ? "No Drive items match the filter."
          : "No Drive items found.",
      })
    ),
    h(Text, { color: mode === "busy" ? "yellow" : "green" }, truncate(status, width)),
    mode === "upload"
      ? h(
          Box,
          { flexDirection: "column" },
          h(Text, { color: "cyan" }, "Local path to upload into current Drive directory:"),
          h(TextInput, {
            value: inputValue,
            onChange: setInputValue,
            onSubmit: (value) => {
              void executeUpload(value);
            },
          })
        )
      : null,
    mode === "rename"
      ? h(
          Box,
          { flexDirection: "column" },
          h(Text, { color: "cyan" }, "New local name:"),
          h(TextInput, {
            value: inputValue,
            onChange: setInputValue,
            onSubmit: (value) => {
              const action = pendingAction;
              setPendingAction(null);
              if (!action || action.type !== "local-rename") {
                setMode("normal");
                return;
              }
              void executeLocalRename(action.targetPath, value);
            },
          })
        )
      : null,
    h(Text, { dimColor: true }, truncate(hints, width)),
    mode === "help" ? renderHelp() : null
  );
}
