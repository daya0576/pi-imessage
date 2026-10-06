# Development Rules

## Style

- Keep answers short. Use plain words; define unavoidable jargon first.
- Explain a non-trivial design as: problem, short example, solution.
- Answer the user's question before editing anything.
- When responding to feedback, say whether you agree before saying what you changed.
- Code, comments, commits and docs in English; chat in the user's language. No emojis in code, commits or issues.

## Architecture

- Read `docs/architecture.md` and `docs/adr/` before changing what they cover.
- Keep the layering; `test/architecture.test.ts` is the rule.
- A new or reversed decision starts as a new ADR with status `proposed`; the user accepts it. Never edit an accepted ADR; supersede it with a new one.
- Feature scope and progress live in the GitHub issue, not in docs.
- Keep data users rely on compatible: `settings.json`, memory JSONL, `cron/jobs.json`, reminders, HTTP endpoints. Internal code keeps no backward compatibility.

## Pi Durable References

Read the upstream README and relevant examples before implementing Durable behavior:

- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md): concepts and API usage.
- [Runnable examples](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples): documents, storage, tasks, tools, recovery and agents.
- [Small coding agent on Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/durable): an application built on the harness.
- [Vacation planning agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/vacation): another application example.

Pi Durable is experimental. These links follow upstream `main`; compare examples
with the dependency version pinned in this project before adopting their APIs.

## Code Quality

- No abstraction until needed. Functions over classes. No DI frameworks.
- Inline single-line helpers that have one call site.
- No `any` unless absolutely necessary.
- Check `node_modules` for external API types; don't guess.
- Top-level imports only: no `await import()`, no `import("pkg").Type`.
- Erasable TypeScript only (no `enum`, `namespace`, parameter properties); import local files with `.ts`.
- Descriptive names; no meaningless abbreviations.
- Update log statements together with the logic they describe.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep.
- Ask before removing functionality that looks intentional.
- Web UI: one font (`13px/1.6 monospace`), minimal CSS, ASCII look; no rounded corners, shadows, gradients, or colors beyond opacity.

## Commands

- After code changes: `npm run check` (full output, no tail). Fix all errors, warnings and infos. It does not run tests.
- While working, run only the test files you touched, and iterate until they pass.
- Before a commit: full `npm test` and `npm run check`.
- Write ad-hoc scripts to `/tmp`; delete them when done.
- Never send real iMessages, call paid models, or touch the production `WORKING_DIR` from tests or dev runs. Use the faux provider and temp directories.

## Testing

- About 40 tests in total, each for a distinct behavior of our code. Don't retest Durable.
- Over budget: delete a weaker test before adding one.
- A regression test for an issue gets the issue number in a comment.

## Dependencies

- Pin direct dependencies to exact versions. Review lockfile changes like code.
- Install with `npm install --ignore-scripts` or `npm ci --ignore-scripts`.

## Git

- One conversation, one worktree and branch. Create or reuse it before editing,
  including after restart. Never edit the main checkout or automatically delete
  a dirty worktree.
- After the branch is merged and pushed, remove its clean worktree with
  `git worktree remove` (no `--force`) and the branch with `git branch -d`.
- Merge and deploy serially; never run two real message pipelines concurrently.
- After each completed project change, run required checks, deploy and verify
  as needed, then commit and push to the tracking remote. These actions are
  pre-authorized; do not ask again.
- Commit only intended changes; exclude unrelated drafts, temporary files and
  credentials. Stage explicit paths, never `git add -A` or `git add .`.
- Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`,
  `--no-verify`, or force push. Stop and report any rejected push.
- Commit messages: `type(scope): summary`.
  Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

## Issues

- Post issues and comments with `gh ... --body-file`, never a multi-line `--body`.
- Close issues from commits with `closes #n`, one keyword per issue.

## Deploy

- Deploy and verify each completed change without asking again for routine deployment approval. Follow the routine deployment/restart section in `ops/README.md`; documentation-only edits need no runtime restart.
- Run the service from a fixed release directory, never the main checkout: [Release directories](ops/README.md#release-directories).
- Use [ops/CUTOVER.md](ops/CUTOVER.md) ([ADR 0009](docs/adr/0009-one-shot-cutover.md)) only for the first migration. Never run old and new message pipelines concurrently.
- Routine commits and pushes are separately authorized under Git above. Deployment authorization does not include paid model probes, real test messages, unrelated service changes or data cleanup. Do not require the user to execute authorized commands personally. Stop for new material safety or data-integrity risks.

## User Override

An explicit user instruction sets the scope of the requested operation; do not ask the user to repeat authorization already given. Ask only when the scope is ambiguous, an additional action is outside that scope, or a remaining conflict affects safety or data integrity.
