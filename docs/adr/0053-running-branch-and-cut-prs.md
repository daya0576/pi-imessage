# 0053. One running branch, pull requests cut from commits

Status: accepted (owner accepted on 2026-10-24)

**Problem.** Several conversations change the service at the same time and
the owner wants the newest code running at once, while still reviewing changes
as pull requests when convenient. Review cannot gate the runtime then; it can
only gate `main`. The unreviewed changes need a form that composes across
conversations, keeps authorship and intent, and still lets the owner draw
pull-request boundaries afterwards: what a conversation produced is rarely one
pull request. Per-conversation branches (#46) make the last deploy drop every
other unmerged branch; a dirty shared checkout (no commits, the owner splits
the diff) mixes conversations, loses history and gives nothing to roll back to.

**Example.**

```text
conversation A: fix(web): ...          -> next (deployed, running)
conversation B: feat(agent): ...       -> next (deployed, running)
conversation A: docs(ops): ...         -> next (deployed, running)

owner, days later:
  ops/cut-pr.sh <sha of fix(web)> <sha of docs(ops)>   -> PR "web and ops"
  ops/cut-pr.sh <sha of feat(agent)>                   -> PR "agent"
  merges the first, rejects the second
conversation: git rebase --onto origin/main ... next   -> next = main + feat(agent)
              reverts feat(agent) on next if the owner says so
```

**Decision.**

- The unit of change is the commit, not the branch. Every commit on `next` is
  atomic, passes the required checks, and has a `type(scope): summary` message
  that says what it is for. No work-in-progress or mixed commits.
- `next` is the one running branch. A conversation still works in its own
  worktree on a throwaway branch created from `next`; when a change is done it
  rebases onto `next`, fast-forwards `next` to it, pushes `next`, and deploys
  the `next` head as a release directory through `restart_service`. The
  service always runs a pushed `next` commit.
- `main` changes only through pull requests that the owner cuts from `next`
  commits in any grouping, with `ops/cut-pr.sh`: a branch from `origin/main`,
  cherry-picks, push, `gh pr create`. Conversations do not open pull requests
  and never push `main`.
- After the owner merges, a conversation replays the remaining `next` commits
  onto `origin/main` (`git rebase --onto`), so `next` is always `main` plus the
  not-yet-merged commits, and pushes it (this is the one allowed force push,
  of `next` only, with `--force-with-lease`). A rejected pull request is
  reverted on `next` by a conversation when the owner says so.
- Rollback is a release from `origin/main`.

**Consequences.** The newest code runs as soon as a conversation deploys it,
changes from several conversations stack instead of replacing each other, and
the owner reviews small topic pull requests at any later time. The cost is one
rebase per change, the occasional conflict when `next` is replayed onto a
moved `main`, and cherry-picks that depend on an unmerged commit: the owner
takes the dependency along or asks for the change to be redone independently.
Replaces the per-conversation branch deployment of #46 and the `next` to
`main` integration pull request of #45. The restart tool of ADR 0052 is
unchanged: it still takes the hash of a prepared release directory.
