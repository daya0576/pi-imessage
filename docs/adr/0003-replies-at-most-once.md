# 0003. Replies are sent at most once

Status: proposed (2026-10-04)

**Context.** Sending through Messages.app and recording it in Durable cannot be one atomic step. A crash in between either loses or repeats a reply.

**Decision.** For each final answer: record `sending` in the conversation, send, then record `sent`. On restart, `sending` becomes `unknown`: it is logged and shown in the web UI with a resend button, and never resent automatically. This covers agent replies; `/send`, cron and reminders report their result to the caller or run log.

**Consequences.** A crash in that window of a few milliseconds can drop one reply. Nothing is ever sent twice.

**Rejected.** Send, then record (can send twice). Confirming delivery through `chat.db` GUIDs (complex and unreliable).
