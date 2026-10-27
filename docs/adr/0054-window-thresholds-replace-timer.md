# 0054. The advertised model window bounds chat context; the six-hour timer is retired

Status: accepted (2026-10-27; owner chose the provider-side setting in pi admin)

Replaces the six-hour clause of ADR 0008. Durable's threshold compaction and `/compact` are unchanged.

**Problem.** The six-hour timer compacted every chat with new entries regardless of size: 266 timer cuts since 2026-10-04 at a median context of 63k tokens, each re-summarizing a small conversation, dropping recent detail mid-task and invalidating the prompt cache. Durable's own thresholds sit 16k (blocking) and 48k (background) below the model window, and the gateway advertised 1M tokens, so they were never reached (chat context p50 91k, p95 207k, max 279k).

**Decision.** The host does not configure compaction thresholds. The operator sets the window each model ref advertises (for magpie: `magpie group set <id> context=…`); Durable's default thresholds then apply to that window. The chat group advertises 176k (blocking compaction at 160k, background from ~127k); long-context task children (night sleep review, Reflection) select a second group with the same members advertising the real 1M window. `settings.json` `"scheduledCompaction": false` creates or reloads the `compact-chats` schedule disabled (default `true` keeps ADR 0008); saved state and the Scheduled page need no migration, and `/compact` remains for explicit use.

**Consequences.** Chat context is bounded by the advertised window; idle small chats are never touched; `/status` reports against the same window. Every consumer of that model ref sees the smaller window, including the Pi CLI when it selects the same group. Thresholds follow Durable's fixed offsets, not tuned numbers.

**Rejected.** A `settings.json` context budget converted to per-model Durable overrides (b01f4e8, reverted: ~80 lines of conversion for the same behavior). Removing the `compact-chats` schedule (its run history and abort path are the test coverage for interval schedules). Idle-plus-size conditions on the timer. Per-conversation policy (not offered by Durable).
