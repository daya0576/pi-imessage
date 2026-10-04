# 0005. Import old history once; start with an empty context

Status: proposed (2026-10-04)

**Context.** Old data per chat: `WORKING_DIR/<chat>/log.jsonl` (about 28,000 lines across 12 chats on claw), plus SDK sessions, goals, subagents and several GB of images.

**Decision.** `migrate/migrate.ts` runs once at cutover. Each `log.jsonl` becomes user and assistant entries in that chat's conversation, followed by one reset, so the model starts with an empty context. Attachments move to `WORKING_DIR/attachments/<chat>/`, and entries keep the path. The agent searches old messages by grepping `WORKING_DIR/durable/`; the system prompt says where. SDK sessions, goals, subagents and scratch are archived once, then deleted.

**Consequences.** The model doesn't remember pre-cutover talk until it searches. The web UI shows old and new history the same way.

**Rejected.** Importing the SDK context (different format). A summary per chat at reset (one model call per chat). A separate archive folder.
