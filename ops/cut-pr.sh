#!/bin/bash
# Cut a pull request from next commits (AGENTS.md, Git). Owner tool.
#
#   ops/cut-pr.sh <branch-name> <sha>...
#
# Creates <branch-name> from origin/main, cherry-picks the given next commits
# in the given order, pushes the branch and opens a pull request against main
# whose body lists the picked commits. Stops on a cherry-pick conflict and
# leaves the worktree for the operator; nothing is pushed then.
set -euo pipefail

REPO="${REPO:-/Users/clawbot/pi-imessage-next}"
WORKTREES="${WORKTREES:-/Users/clawbot/pi-imessage-worktrees}"

[ "$#" -ge 2 ] || { echo "usage: $0 <branch-name> <sha>..." >&2; exit 2; }
BRANCH="$1"; shift
[ "$BRANCH" != main ] && [ "$BRANCH" != next ] || { echo "refusing branch name $BRANCH" >&2; exit 2; }

git -C "$REPO" fetch -q origin main next
for SHA in "$@"; do
  git -C "$REPO" merge-base --is-ancestor "$SHA" origin/next || { echo "$SHA is not on origin/next" >&2; exit 2; }
done

DIR="$WORKTREES/pr-$BRANCH"
[ ! -e "$DIR" ] || { echo "$DIR already exists" >&2; exit 2; }
git -C "$REPO" worktree add -b "$BRANCH" "$DIR" origin/main
git -C "$DIR" cherry-pick -x "$@"
git -C "$DIR" push -u origin "$BRANCH"

BODY="$(mktemp)"
{
  echo "Cut from \`next\`. Commits:"
  echo
  for SHA in "$@"; do git -C "$REPO" log -1 --format='- %h %s' "$SHA"; done
} > "$BODY"
TITLE="$(git -C "$REPO" log -1 --format=%s "$1")"
gh pr create --repo "$(git -C "$REPO" remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/]+?)(\.git)?$#\1#')" \
  --base main --head "$BRANCH" --title "$TITLE" --body-file "$BODY"
rm -f "$BODY"
echo "worktree: $DIR (remove with git worktree remove after merge)"
