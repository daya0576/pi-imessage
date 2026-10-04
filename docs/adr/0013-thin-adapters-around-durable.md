# 0013. Use Durable directly; keep adapters thin

Status: proposed (2026-10-04)

**Context.** The drafts grew host state that Durable already keeps (per-command receipts with running/unknown recovery, a reply scan over every settled submission) and copies of other systems (a gzip/base64 Python memory backend inside TypeScript, a vendored 1,000-line scheduler). [0001](0001-durable-owns-state.md) says Durable owns chat state; this records where our code stops.

**Decision.**

- **Commands** call Durable APIs directly (`configure`, `compact`, `reset`, task abort). Each command is first written to the chat conversation as a passive entry with the message GUID as request ID, so a repeated row is skipped by Durable's dedupe. An interrupted command is not replayed. No command receipt state.
- **`/reload`** rereads settings, models and auth, AGENTS and skills, and reinstalls our extensions under the same names; Durable's registry replaces them in place. Running calls finish on their old code. Nothing is paused or cancelled.
- **Memory tools** run the store's own CLI, `WORKING_DIR/skills/file-memory/memory_cli.py`, which finds its data next to itself. No embedded or rewritten backend; a missing CLI is a tool error.
- **Scheduler** keeps the clock: cron expressions, timezones, reminders and their files (`cron/jobs.json`, reminders). When a job fires it submits to Durable with a stable request ID, or sends directly with a receipt. After acceptance, Durable owns execution and recovery; the scheduler never retries model work. Durable 1.0.2 has task `sleep` but no cron or reminder service, so it is not used as one.
- **Web pages** are read-only: they show Harness state and watches (history, live state, task graph, usage) and have no buttons. They keep no execution log of their own. The endpoints in [the HTTP API](../api.md) stay; endpoints used only by the old page buttons (per-chat reply toggle, PT task actions) are removed. Replies are enabled through the settings allowlist; cron jobs are run or paused through the API.
- **Our documents** hold only what Durable cannot know: the `chat.db` cursor, the chat-to-conversation map, send receipts and the active run with its deadline.

**Consequences.** Little host recovery code beyond send receipts. Memory needs Python and the store's CLI at runtime (Python is already a prerequisite). The scheduler stays a larger, separate module, isolated behind one submit or send call.

**Rejected.** Command receipts and a command state machine. Pausing work around `/reload`. Embedding or reimplementing the memory backend. Rewriting cron and reminders as Durable tasks. A separate execution log for the UI. Page buttons, including a resend button for `unknown` replies.
