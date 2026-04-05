# Contributing to Aethel

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/CCJ-0617/Aethel.git
cd Aethel
npm install
npm test
```

Requires Node.js >= 18.

## Running Locally

```bash
node src/cli.js auth          # one-time OAuth setup
node src/cli.js --help        # see all commands
node src/cli.js tui           # launch the terminal UI
```

## Project Structure

```
src/
  cli.js              # CLI entry point (Commander)
  core/
    auth.js            # OAuth authentication
    drive-api.js       # Google Drive API wrapper
    sync.js            # Sync execution with concurrency
    diff.js            # 3-way diff (snapshot vs remote vs local)
    snapshot.js        # Local file scanning and hashing
    staging.js         # Git-like staging area
    config.js          # Workspace config (.aethel/)
    ignore.js          # .aethelignore support
    local-fs.js        # Local filesystem operations
    remote-cache.js    # Short-lived remote state cache
  tui/
    app.js             # Ink + React terminal UI
    index.js           # TUI entry point
test/
  drive-api.test.js    # Tests (Node.js built-in test runner)
```

## Making Changes

1. Create a branch from `main`.
2. Make your changes.
3. Run `npm test` to verify all tests pass.
4. Run `npm run pack:check` to verify the package contents.
5. Open a pull request against `main`.

## Code Style

- ES modules (`import`/`export`), no CommonJS.
- Prefer `async`/`await` over raw promises.
- No TypeScript — plain JavaScript with JSDoc where helpful.
- Keep dependencies minimal.

## Tests

Tests use the Node.js built-in test runner (`node --test`). Run with:

```bash
npm test
```

When adding new functionality to `drive-api.js` or `sync.js`, add tests using
the `createFakeDrive()` helper in the test file.

## Reporting Issues

Use the [issue templates](https://github.com/CCJ-0617/Aethel/issues/new/choose)
for bug reports and feature requests.
