# 0054. The advertised model window bounds chat context; the six-hour timer is removed

Status: accepted (2026-10-27; owner chose the provider-side setting and asked for the timer to be deleted, in pi admin)

Replaces the six-hour clause of ADR 0008 and the timer-specific quiet rule of ADR 0031. Durable's threshold compaction and `/compact` are unchanged.

**Problem.** The six-hour timer compacted every chat with new entries regardless of size: 266 timer cuts since 2026-10-04 at a median context of 63k tokens, each re-summarizing a small conversation, dropping recent detail mid-task and invalidating the prompt cache. Durable's own thresholds sit 16k (blocking) and 48k (background) below the model window, and the gateway advertised 1M tokens, so they were never reached (chat context p50 91k, p95 207k, max 279k).

**Decision.** The host defines no schedule and configures no compaction. The operator sets the window each model ref advertises (for magpie: `magpie group set <id> context=…`); Durable's default thresholds then apply to that window. The chat group advertises 176k (blocking compaction at 160k, background from ~127k); long-context task children (night sleep review, Reflection) select a second group with the same members advertising the real 1M window. The `compact-chats` job, its execution phase and the quiet-progress classification are deleted. A saved framework-owned job without a definition is removed from the schedule document at initialization and its scheduler task aborted, so it leaves the Scheduled page; a scheduler waking for a missing job ends instead of faulting. Workspace jobs keep ADR 0035 (disabled with history).

**Consequences.** Chat context is bounded by the advertised window; idle small chats are never touched; `/status` reports against the same window. Every consumer of that model ref sees the smaller window, including the Pi CLI when it selects the same group. Thresholds follow Durable's fixed offsets, not tuned numbers. Durable's automatic compactions report progress like any native task (ADR 0040).

**Rejected.** A `settings.json` context budget converted to per-model Durable overrides (b01f4e8, reverted: ~80 lines of conversion for the same behavior). A `scheduledCompaction` switch keeping the job defined but disabled (60d8370: still listed on the Scheduled page). Idle-plus-size conditions on the timer. Per-conversation policy (not offered by Durable).
