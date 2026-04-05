#!/usr/bin/env bash
set -euo pipefail

# ── Usage ────────────────────────────────────────────────────────────
# ./scripts/release.sh <patch|minor|major> "One-line summary"
#
# Steps:
#   1. Run tests
#   2. Stage & commit all changes (if any)
#   3. Push to GitHub
#   4. Trigger the Version & Release workflow (bump, tag, npm publish)
#   5. Wait for the workflow to finish
#   6. Pull the version bump commit
# ─────────────────────────────────────────────────────────────────────

BUMP="${1:-}"
SUMMARY="${2:-}"

if [[ -z "$BUMP" || -z "$SUMMARY" ]]; then
  echo "Usage: ./scripts/release.sh <patch|minor|major> \"Release summary\""
  echo ""
  echo "Examples:"
  echo "  ./scripts/release.sh patch \"Fix auth default path\""
  echo "  ./scripts/release.sh minor \"Add Repository pattern\""
  exit 1
fi

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Error: bump must be one of: patch, minor, major"
  exit 1
fi

# Check tools
for cmd in git gh npm node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is not installed"
    exit 1
  fi
done

CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"
echo "Bump: $BUMP"
echo "Summary: $SUMMARY"
echo ""

# 1. Run tests
echo "── Running tests ──"
npm test
echo ""

# 2. Commit uncommitted changes (if any)
if [[ -n "$(git status --porcelain)" ]]; then
  echo "── Committing changes ──"
  git add -A
  git commit -m "$SUMMARY"
  echo ""
fi

# 3. Push to GitHub
echo "── Pushing to GitHub ──"
git push origin main
echo ""

# 4. Trigger Version & Release workflow
echo "── Triggering Version & Release workflow ──"
gh workflow run version.yml \
  --field "bump=$BUMP" \
  --field "summary=$SUMMARY"

# Wait a moment for the run to register
sleep 3

# Find the run ID
RUN_ID=$(gh run list --workflow=version.yml --limit 1 --json databaseId --jq '.[0].databaseId')
echo "Workflow run: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions/runs/$RUN_ID"
echo ""

# 5. Wait for completion
echo "── Waiting for workflow to complete ──"
if gh run watch "$RUN_ID" --exit-status; then
  echo ""
  echo "── Pulling version bump ──"
  git pull origin main

  NEW_VERSION=$(node -p "require('./package.json').version")
  echo ""
  echo "Released v$NEW_VERSION"
  echo "  npm: https://www.npmjs.com/package/aethel/v/$NEW_VERSION"
  echo "  GitHub: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$NEW_VERSION"
else
  echo ""
  echo "Workflow failed. Check: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions/runs/$RUN_ID"
  exit 1
fi
