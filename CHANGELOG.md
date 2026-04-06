# Changelog

## 0.4.0 (2026-04-06)

- Add pull --all for full remote download

## 0.3.8 (2026-04-06)

- Fix Drive upload checksum test stub

## 0.3.7 (2026-04-05)

- Fix orphan checker not recognizing My Drive root — all files under synced folders were silently dropped

## 0.3.6 (2026-04-05)

- Optimize status and saveSnapshot performance: parallelize loadState, skip redundant fetches, increase hash concurrency

## 0.3.5 (2026-04-05)

- Add progress bars and spinners for all time-consuming CLI operations

## 0.3.4 (2026-04-05)

- Add empty folder sync support between local and Google Drive

## 0.3.3 (2026-04-05)

- Persist credentials to ~/.config/aethel/ after auth for seamless init

## 0.3.2 (2026-04-05)

- Add --version flag, interactive init folder selection, and release script

## 0.3.1 (2026-04-05)

- Improve setup SOP: default credentials to ~/.config/aethel/ with guided error message

## 0.3.0 (2026-04-05)

- Refactor to Repository pattern; add TUI command system with catalog, CLI runner, and tests

## 0.2.6 (2026-04-05)

- Rewrite README with clearer structure and usage examples

## 0.2.5 (2026-04-05)

- Fix Node.js v25 Proxy invariant violation in withDriveRetry

## 0.2.4 (2026-04-05)

- Fix npm publish authentication in CI workflow

## 0.2.3 (2026-04-05)

- Enable npm trusted publishing via version workflow

## 0.2.2 (2026-04-05)

- Retry npm publish after CI release attempt

## 0.2.1 (2026-04-05)

- Fix auth error propagation

## 0.2.0 (2026-04-05)

- Fix auth error propagation

## 0.1.1 (2026-04-05)

- Add retry logic for Drive API calls

## 0.1.0

- Initial npm release of the Aethel CLI and Ink TUI
- Google Drive OAuth authentication and workspace initialization
- Git-style sync workflow with snapshot, diff, staging, pull, push, and commit
- Conflict resolution, restore, ignore management, and history inspection
- Duplicate-folder detection and reconciliation for Google Drive
