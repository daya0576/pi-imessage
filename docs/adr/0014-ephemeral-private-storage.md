# 0014. Keep ephemeral transcripts in disposable private storage

Status: superseded by [0018](0018-tasks-without-prompt-api.md) (2026-10-05). Was: proposed (2026-10-04)

**Context.** The retained HTTP `ephemeral:true` contract removes an isolated session after its queued work finishes. Durable 1.0.2 has reset/compaction but no public single-conversation deletion API. Reset hides old context from the model; it does not erase stored prompts, tool results or child conversations.

**Example.** An automated task reads private files. Its final answer may stay in the destination chat, but its private task transcript must not remain searchable in the ordinary conversation store after cleanup.

**Decision proposed for owner acceptance.** Give each active ephemeral `(chatGuid, sessionKey)` its own private JSONL storage and native Harness. Let Durable own that storage's inbox, dedupe, steering, tasks and recovery. The main store keeps only opaque identity/lifecycle metadata needed to locate it and external send receipts, not its private prompt/tool transcript. Admission success follows persisted private admission. On restart, reopen recorded private storage and resume its native work; never replay a whole turn in the host. Deliver completed answers with stable main-store receipts. Once the private Harness is idle and its completed answers have an authoritative sent/unknown disposition, close it and remove its directory with restart-safe cleanup. A later batch with the same key starts a fresh private context. Do not remove an active directory or silently lose queued work.

**Consequences.** Extra storage/lifecycle wiring is necessary for the old privacy promise, but no second model loop or mirrored inbox. Repeated request IDs and uncertain sends need checks across cleanup/restart. HTTP ephemeral admission remains blocked until this design is accepted, implemented and verified. Ordinary API/cron contexts stay in the shared store.

**Rejected.** Calling reset and claiming deletion. Editing shared append-only storage behind Durable. Retaining private transcripts in the main store. Dropping ephemeral behavior without owner approval.
