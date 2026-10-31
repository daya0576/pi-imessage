# Architecture decision records

These are the decisions in force. Accepted ADR files are never edited.

| ADR | Decision |
|---|---|
| [0001](0001-durable-owns-state.md) | Pi Durable owns all chat state |
| [0002](0002-module-layering.md) | Modules in strict layers |
| [0004](0004-native-extensions.md) | Native Durable extensions, not an SDK adapter |
| [0006](0006-jsonl-storage.md) | One JSONL storage, backed up by hand |
| [0007](0007-images-by-path.md) | Store images as file paths |
| [0010](0010-test-budget.md) | About 40 tests |
| [0011](0011-reconcile-unsent-answers.md) | Reconcile unsent answers |
| [0012](0012-run-in-owned-conversation.md) | `/run` in an owned conversation |
| [0054](0054-window-thresholds-replace-timer.md) | The advertised model window bounds chat context; no compaction timer |

## Adding an ADR

Do not add an ADR on your own initiative. A new ADR, including one that
reverses a decision above, is written only during a grilling session (the
`grilling` skill), to record what the owner settled there. Outside such a
session, describe the change in the GitHub issue, `docs/architecture.md` or
the code.

## Removed ADRs

All other ADRs were removed on 2026-10-31, together with every reference to
them. The files are kept at the annotated tag `archive/adr-pre-prune`
(`git show archive/adr-pre-prune:docs/adr/<file>`).
