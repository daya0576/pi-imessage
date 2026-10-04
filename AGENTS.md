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

- Commit only when the user asks.
- Stage explicit paths; never `git add -A` or `git add .`.
- Never `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `--no-verify`, or force push.
- Message: `type(scope): summary`, with type one of `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

## Issues

- Post issues and comments with `gh ... --body-file`, never a multi-line `--body`.
- Close issues from commits with `closes #n`, one keyword per issue.

## Deploy

- No deployment before cutover ([ADR 0009](docs/adr/0009-one-shot-cutover.md)). After it, deploy only when the user asks, following `ops/README.md`.
- Never restart the running service from inside the agent.

## User Override

If the user's instructions conflict with a rule here, ask for explicit confirmation before overriding it.
