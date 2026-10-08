#!/bin/bash
# Moves the tested changes from the `dev` branch to `master`, and updates the
# stable copy (the folder on `master`) that AgentDeck.app runs.
#
# Run it from the dev folder:
#   npm run promote                  move dev to master
#   npm run promote -- 0.2.0         also set the version to 0.2.0 and tag it v0.2.0
#   npm run promote -- 0.2.0 --push  also upload master, dev and the tag to GitHub
#
# Afterwards, quit and reopen AgentDeck to use the new version.

set -euo pipefail

DEV="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=""
PUSH=false
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=true ;;
    *) VERSION="$arg" ;;
  esac
done

cd "$DEV"
if [ "$(git branch --show-current)" != "dev" ]; then
  echo "Run this from the folder that is on the dev branch." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "The dev folder has uncommitted changes. Commit them first." >&2
  exit 1
fi

# The stable copy is the worktree that has master checked out.
STABLE="$(git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch refs\/heads\/master$/{print p}')"
if [ -z "$STABLE" ]; then
  echo "No folder has the master branch checked out." >&2
  exit 1
fi

if [ -n "$VERSION" ]; then
  npm version "$VERSION" --no-git-tag-version >/dev/null
  git commit -qam "Release v$VERSION"
fi

OLD="$(git -C "$STABLE" rev-parse HEAD)"
git -C "$STABLE" merge --ff-only -q dev
NEW="$(git -C "$STABLE" rev-parse HEAD)"
if [ -n "$VERSION" ]; then git -C "$STABLE" tag "v$VERSION"; fi

if [ "$OLD" = "$NEW" ]; then
  echo "master already has everything from dev."
else
  echo "master moved from ${OLD:0:7} to ${NEW:0:7}:"
  git -C "$STABLE" log --oneline "$OLD..$NEW"
fi

# New or updated packages: install them in the stable copy too.
if ! git -C "$STABLE" diff --quiet "$OLD" "$NEW" -- package-lock.json; then
  echo "Packages changed, installing them in the stable copy…"
  (cd "$STABLE" && npm ci)
fi

# A new Electron version or a new icon needs a rebuilt app.
if ! git -C "$STABLE" diff --quiet "$OLD" "$NEW" -- build/icon.png scripts/make-app.sh package-lock.json; then
  echo "Rebuilding AgentDeck.app…"
  bash "$STABLE/scripts/make-app.sh"
fi

if $PUSH; then
  git push -q origin master dev
  if [ -n "$VERSION" ]; then git push -q origin "v$VERSION"; fi
  echo "Uploaded to GitHub."
fi

echo "Done. Quit and reopen AgentDeck to use the new version."
