# Architecture decision records

Accepted ADR files are never edited; this index records which ones are current.
"Active" means the decision is in force. A replaced ADR points to its successor.

## Current

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-durable-owns-state.md) | Pi Durable owns all chat state | Active |
| [0002](0002-module-layering.md) | Modules in strict layers | Active |
| [0003](0003-replies-at-most-once.md) | Replies are sent at most once | Active |
| [0004](0004-native-extensions.md) | Native Durable extensions, not an SDK adapter | Active; Codex tier clause replaced by 0036 |
| [0006](0006-jsonl-storage.md) | One JSONL storage, backed up by hand | Active |
| [0007](0007-images-by-path.md) | Store images as file paths | Active |
| [0008](0008-compaction-and-run.md) | Six-hour compaction | Active; `/run` clause replaced by 0012 |
| [0010](0010-test-budget.md) | About 40 tests | Active |
| [0011](0011-reconcile-unsent-answers.md) | Reconcile unsent answers | Active |
| [0012](0012-run-in-owned-conversation.md) | `/run` in an owned conversation | Active |
| [0013](0013-thin-adapters-around-durable.md) | Thin adapters around Durable | Active; scheduler clause replaced by 0042 |
| [0016](0016-process-http-transport.md) | One process-owned HTTP transport | Active |
| [0017](0017-browser-cli-owned-scope.md) | Conversation-scoped browser CLI tool | Accepted, to be implemented |
| [0018](0018-tasks-without-prompt-api.md) | Ordinary `/stop`; no HTTP `/prompt` or `/send` | Active |
| [0036](0036-workspace-policy-and-neutral-service-id.md) | Workspace policy and neutral service ID | Active |
| [0040](0040-chat-progress-notices.md) | Chat progress notices | Active; consolidates 0020–0028, 0031 |
| [0041](0041-restart-and-recovery.md) | Restart and recovery | Active; consolidates 0037–0039 |
| [0042](0042-background-schedules-and-workspace-extensions.md) | Background schedules and workspace extensions | Active; operator-run clause replaced by 0047 |
| [0043](0043-remove-legacy-migration.md) | Remove the legacy migration code | Active; archived at tag `archive/legacy-migration` |
| [0044](0044-message-channels.md) | Organize message sources as channels | Proposed |
| [0045](0045-chat-scheduling-tools.md) | Native chat scheduling tools | Proposed |

| [0046](0046-selective-command-redaction.md) | Selective command-preview redaction | Proposed; owner-requested implementation in #36 |
| [0047](0047-one-scheduling-path.md) | One scheduling path for recurring and one-off work | Active |
| [0048](0048-quiet-attachment-reads.md) | Quiet attachment reads | Proposed; owner-requested implementation in #38 |

## Replaced or rejected

| ADR | Decision | Replaced by |
|---|---|---|
| [0005](0005-history-migration.md) | Import old history once | 0043 (done) |
| [0009](0009-one-shot-cutover.md) | Switch over in one step | 0043 (done) |
| [0014](0014-ephemeral-private-storage.md) | Ephemeral private storage | 0018 |
| [0015](0015-ordinary-stop-keeps-native-inbox.md) | `/stop` keeps the native inbox | 0018 |
| [0030](0030-shared-web-read-cache.md) | Shared web read cache | Rejected; removed |
| [0019](0019-remove-scheduled-services.md) | Remove scheduled services | 0042 |
| [0020](0020-chat-task-progress.md)–[0028](0028-command-preview-120.md) | Progress notice format | 0040 |
| [0031](0031-quiet-compaction-progress.md) | Quiet six-hour compaction progress | 0040 |
| [0032](0032-native-background-schedules.md)–[0035](0035-external-business-task-extensions.md) | Native schedules, operator run, local time, workspace extensions | 0042 |
| [0037](0037-restart-during-in-flight-work.md)–[0039](0039-rerun-interrupted-tools.md) | Restart and tool rerun | 0041 |

Number 0029 was never used.
