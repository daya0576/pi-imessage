# 0054. Context budget compaction replaces the six-hour timer

Status: accepted (2026-10-27; owner asked for budget-driven background compaction in pi admin)

Replaces the six-hour clause of ADR 0008. Durable's threshold compaction and `/compact` are unchanged.

**Problem.** The six-hour timer compacts every chat with new entries regardless of size. Since 2026-10-04 it admitted 266 compactions; the context right before a cut had a median of 63k tokens, so most cuts re-summarized small conversations, dropped recent detail mid-task and invalidated the prompt cache. Durable's own thresholds sit 16k/48k below the model window, which magpie reports as 1M tokens, so without the timer a chat would grow to hundreds of thousands of tokens per request (chat p50 91k, p95 207k, max 279k).

**Decision.** `settings.json` may declare a context budget:

```json
"compaction": { "budgetTokens": 160000, "backgroundTokens": 60000, "exempt": ["magpie/group/claude-gpt-long"] }
```

The host turns it into Durable `compaction.modelOverrides` for every known model whose window exceeds the budget: blocking compaction at the budget (`reserveTokens = contextWindow - budgetTokens`) and background compaction `backgroundTokens` below it. Narrower models keep Durable's defaults. Exempt `provider/modelId` refs set `enabled: false`; long-context task children (night sleep review, Reflection) select such a ref. While a budget is configured the `compact-chats` schedule is created or reloaded disabled; removing the budget re-enables it on the next reload. `/status` reports usage against the budgeted window. Settings are read at each request and recomputed on `/reload` from the refreshed model list.

**Numbers.** 160k/100k from the archive: the post-compaction floor is p50 38k, max 70k (prefix, summary, 20k kept verbatim), so background compaction at 100k never follows a cut immediately; the 60k gap covers the p99 single-turn growth (60k), so compaction almost always finishes in the background and lands at a turn boundary.

**Consequences.** Chat context is bounded by the budget instead of the model window; idle small chats are never touched. Durable's policy is per model, not per conversation, so exemptions need a distinct model ref. A running turn that grows past the budget still blocks on compaction, as before.

**Rejected.** Idle-plus-size conditions on the timer (another summarization loop beside Durable's). Per-conversation policy (not offered by Durable). Lowering the window magpie advertises (hides the real window from every consumer).
