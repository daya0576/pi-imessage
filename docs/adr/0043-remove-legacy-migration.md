# 0043. Remove the legacy migration code

Status: accepted (owner decided on 2026-10-06)

**Problem.** The one-time cutover from the legacy service is done, but its code
and runbook remain: `src/migrate/`, the `pi-imessage import` command, a test and
`ops/CUTOVER.md`. Readers must learn a whole layer that will never run again.

**Example.** A new contributor reads the package table, finds `migrate/` next to
`main.ts`, and spends time on history import rules unrelated to any change.

**Decision.**

- Delete `src/migrate/`, the `import` CLI command, `test/migrate.test.ts` and
  `ops/CUTOVER.md`.
- Keep them reachable at the annotated tag `archive/legacy-migration`, the last
  revision that contains them. A tag is fixed and runnable; a wiki copy is not.
- The rule "never run old and new message pipelines concurrently" stays in
  `AGENTS.md` and `ops/README.md`.

**Consequences.** Imported history already lives in Durable storage and is
unaffected. Rerunning a migration means checking out the tag in a separate
worktree. This replaces ADRs 0005 and 0009, whose work is complete.
