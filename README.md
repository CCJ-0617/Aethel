# Aethel

[![CI](https://github.com/CCJ-0617/Aethel/actions/workflows/ci.yml/badge.svg)](https://github.com/CCJ-0617/Aethel/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/aethel)](https://www.npmjs.com/package/aethel)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**Git-style Google Drive sync from your terminal.**

Aethel brings a `snapshot → diff → stage → commit` workflow to Google Drive. Track changes on both sides, resolve conflicts explicitly, and keep a full sync history — all without leaving the command line. It also ships with a dual-pane TUI for hands-on file management.

---

## Install

```bash
npm install -g aethel
```

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/CCJ-0617/Aethel.git
cd Aethel
npm install
npm run install:cli   # symlinks `aethel` into ~/.local/bin
```

</details>

**Requires Node.js >= 18**

## Setup

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Google Drive API**
3. Create an **OAuth 2.0 Client ID** (Desktop application)
4. Download the credentials JSON and save it as `credentials.json` in your project root

```bash
aethel auth                    # opens browser, saves token.json
aethel init --local-path ./workspace --drive-folder <folder-id>
```

> `credentials.json` and `token.json` are local secrets — never commit them.

## Usage

```bash
aethel status                  # local vs remote changes at a glance
aethel diff --side all         # detailed file-level diff
aethel add --all               # stage default suggested actions
aethel commit -m "sync"        # execute staged operations

aethel pull -m "pull"          # fetch remote changes and apply
aethel push -m "push"          # push local changes to Drive
```

### Conflict Resolution

When both local and remote change the same path:

```bash
aethel status                  # identify conflicts
aethel resolve <path> --keep local   # or: remote, both
aethel commit -m "resolve"
```

### Deduplication

Multi-device conflicts can leave duplicate folders on Drive:

```bash
aethel dedupe-folders            # dry run — report only
aethel dedupe-folders --execute  # merge duplicates, trash empties
```

Processes deepest-first for single-pass convergence, caches child state to minimize API calls, and runs independent merge groups in parallel.

## Commands

| Command | Description |
|---------|-------------|
| `auth` | OAuth flow — creates `token.json`, verifies Drive access |
| `init` | Initialize a local sync workspace |
| `status` | Show local vs remote changes |
| `diff` | Detailed file differences |
| `add` | Stage changes |
| `reset` | Unstage changes |
| `commit` | Execute staged sync operations |
| `pull` | Fetch and apply remote changes |
| `push` | Push local changes to Drive |
| `log` | Sync history |
| `fetch` | Refresh remote state without applying |
| `resolve` | Resolve conflicts (local / remote / both) |
| `ignore` | Manage `.aethelignore` patterns |
| `show` | Inspect a saved snapshot |
| `restore` | Restore files from the last snapshot |
| `rm` | Remove local files and stage remote deletion |
| `mv` | Move or rename local files |
| `clean` | List and optionally trash/delete Drive files |
| `dedupe-folders` | Detect and merge duplicate remote folders |
| `tui` | Launch interactive terminal UI |

## TUI

```bash
aethel tui
```

Dual-pane file browser — local filesystem on the left, Google Drive on the right.

| Key | Action |
|-----|--------|
| `Tab` | Switch panes |
| `Left` / `Right` | Navigate up / into directories |
| `u` | Upload selected local file or folder to Drive |
| `s` | Batch sync local folder to current Drive directory |
| `U` | Upload from a manually entered path |
| `n` | Rename selected local item |
| `x` | Delete selected local item |
| `Space` | Toggle selection in Drive pane |
| `t` / `d` | Trash / permanently delete selected Drive items |
| `/` | Filter by name |
| `f` | Open the commands page and choose a TUI action |
| `:` | Run any Aethel CLI command inside the TUI |

## Ignore Patterns

Create `.aethelignore` (gitignore syntax) in your workspace root — or run `aethel init` to generate a default one.

```gitignore
.venv/
node_modules/
__pycache__/
.idea/
dist/
build/
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_DRIVE_CREDENTIALS_PATH` | `credentials.json` | Path to OAuth credentials |
| `GOOGLE_DRIVE_TOKEN_PATH` | `token.json` | Path to cached OAuth token |
| `AETHEL_DRIVE_CONCURRENCY` | `40` | Max concurrent Drive API requests |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module structure and data flow.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
