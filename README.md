# Aethel

[![CI](https://github.com/CCJ-0617/Aethel/actions/workflows/ci.yml/badge.svg)](https://github.com/CCJ-0617/Aethel/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/aethel)](https://www.npmjs.com/package/aethel)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**Git-style Google Drive sync CLI with an interactive terminal UI.**

Aethel lets you manage a local workspace mirrored to Google Drive using
familiar commands (`init`, `status`, `diff`, `add`, `commit`, `pull`, `push`)
and ships with a dual-pane TUI for browsing, uploading, and deleting files
across local and remote directories.

## Install

```bash
npm install -g aethel
```

Or install from source:

```bash
git clone https://github.com/aethel/aethel.git
cd aethel
npm install
npm run install:cli   # symlinks `aethel` into ~/.local/bin
```

**Requirements:** Node.js >= 18

## Release Readiness

- npm package metadata is defined in `package.json`
- publish contents are restricted through the `files` allowlist
- local secrets such as `credentials.json` and `token.json` are excluded from Git and npm publish
- release validation runs with `npm test` and `npm run pack:check`

## GitHub Automation

- `CI`: runs `npm ci`, `npm test`, and `npm run pack:check` on every push and pull request across Node.js 18, 20, and 22
- `Version & Release`: bumps the version, updates the changelog, creates a GitHub Release, publishes to npm, and publishes to GitHub Packages
- `Publish GitHub Packages (manual)`: manually publishes the package to GitHub Packages only
- `Dependabot`: opens weekly dependency update PRs for npm packages and GitHub Actions

To enable npm trusted publishing, configure a trusted publisher for package `aethel` on npm with:

- provider: GitHub Actions
- owner: `CCJ-0617`
- repository: `Aethel`
- workflow filename: `version.yml`

After trusted publishing works once, disable token-based npm publishing in GitHub Actions and revoke any old npm automation tokens.

## Google Cloud Setup

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Google Drive API**.
3. Create an **OAuth 2.0 Client ID** (application type: Desktop).
4. Download the credentials JSON and save it as `credentials.json` in your
   project root (or set `GOOGLE_DRIVE_CREDENTIALS_PATH`).

Keep `credentials.json` and `token.json` local only. Do not commit them to GitHub.

## Quick Start

```bash
# Authenticate and verify access
aethel auth

# Initialize a sync workspace
aethel init --local-path ./workspace

# Optional: target a specific Drive folder
aethel init --local-path ./workspace \
  --drive-folder <folder-id> \
  --drive-folder-name "My Project"

# Check status and sync
aethel status
aethel diff --side all
aethel add --all
aethel commit -m "initial sync"
aethel pull -m "pull"
aethel push -m "push"
aethel log -n 10
```

## Commands

| Command | Description |
|---------|-------------|
| `auth` | Run OAuth flow, create `token.json`, verify Drive access |
| `init` | Initialize a local sync workspace |
| `status` | Show workspace status (local vs remote changes) |
| `diff` | Show detailed file differences |
| `add` | Stage changes for commit |
| `reset` | Unstage changes |
| `commit` | Execute staged sync operations |
| `pull` | Fetch remote changes and commit |
| `push` | Stage and push local changes |
| `log` | Show sync history |
| `fetch` | Refresh remote state without applying changes |
| `resolve` | Resolve conflicts by choosing local, remote, or both |
| `ignore` | List, test, or create `.aethelignore` patterns |
| `show` | Show a saved snapshot |
| `restore` | Restore files from the last snapshot |
| `rm` | Remove local files and stage remote deletion |
| `mv` | Move or rename local files |
| `clean` | List and optionally trash/delete accessible Drive files |
| `dedupe-folders` | Detect and merge duplicate remote folders |
| `tui` | Launch interactive terminal UI |

## TUI

```bash
aethel tui
```

Dual-pane file browser with local filesystem on the left and Google Drive on
the right.

| Key | Action |
|-----|--------|
| `Tab` | Switch focus between Local / Drive pane |
| `Left` / `Right` | Navigate up / into directories |
| `u` | Upload selected local file or folder to current Drive directory |
| `s` | Batch sync local folder contents to current Drive directory |
| `U` | Upload from a manually entered local path |
| `n` | Rename selected local item |
| `x` | Delete selected local item |
| `Space` | Toggle selection in Drive pane |
| `t` / `d` | Trash / permanently delete selected Drive items |
| `/` | Filter by name |

## Deduplication

When duplicate folders accumulate from multi-device conflicts, run:

```bash
# Dry run — report duplicates without changing anything
aethel dedupe-folders

# Execute — merge duplicates and trash empty losers
aethel dedupe-folders --execute
```

The deduplication engine processes folders deepest-first to guarantee
single-pass convergence, caches child state in memory to minimize API calls,
and runs independent merge groups in parallel. Paths matching `.aethelignore`
are excluded automatically.

## Ignore Patterns

Create a `.aethelignore` file (gitignore syntax) in your workspace root to
exclude paths from sync and deduplication:

```gitignore
.venv/
node_modules/
__pycache__/
.idea/
.vscode/
dist/
build/
```

A default `.aethelignore` is created on `init`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_DRIVE_CREDENTIALS_PATH` | `credentials.json` | Path to OAuth credentials |
| `GOOGLE_DRIVE_TOKEN_PATH` | `token.json` | Path to cached OAuth token |
| `AETHEL_DRIVE_CONCURRENCY` | `40` | Max concurrent Drive API requests |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module structure and data
flow.

## Publishing

```bash
npm test
npm run pack:check
npm publish
```

For a GitHub release, push the tagged version and create a release that matches
the published npm version.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
