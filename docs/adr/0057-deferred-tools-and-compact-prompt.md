# 0057. Deferred tools and a compact prompt

Status: proposed (owner-requested implementation, 2026-10-31, "aggressive: hide and trim as much as possible, keep tools the same in every conversation", #48)

**Problem.** A new chat's first request carried about 17k tokens before the
user's message. Most of it was tools and skills that 30 days of history show
are rarely used: five immich tools, five night-sleep tools, vaultwarden,
browser, subagent and restart together had fewer than 200 calls, and ten of
twenty catalogued skills were never read. Every request pays for them, and
every change to them misses the provider prompt cache.

**Example.**

```text
offered:  read bash edit write send_message search_memory load_memory
          save_memory web_search fetch_content tool_search
prompt:   ...Load one with tool_search before calling it: browser,
          immich_search, night_sleep_report, restart_service, subagent, ...
model:    tool_search {query: "immich photo search"}
          -> Loaded 3 tools. They are available from your next call
model:    immich_search {query: "..."}
```

**Decision.**

- Durable's own `deferred: true` and `tool_search`
  (`@earendil-works/pi-durable/tool-search`) replace our own exposure rules.
  The host offers a fixed core set; every other built-in or workspace tool is
  deferred when loaded. The rule is the same in every conversation; no
  per-chat tool lists.
- `tool_search` writes loaded tools into the conversation's `modelTools`, so
  they stay offered on that branch, also after a compaction.
- A `deferred-tools` prompt section lists the names of all deferred tools,
  sorted, so the model knows what to search for. It includes tools already
  loaded, which keeps the section constant within a conversation.
- Child conversations that set an explicit `tools` array get only what is not
  deferred. Scheduled children use core tools only; a child that needs a
  deferred tool must name it in `modelTools`. The subagent child no longer gets
  `get_search_results` unless the parent loaded it.
- The skills catalog is one line per skill, grouped under the directory that
  holds `<name>/SKILL.md`, instead of one XML block with its full path each.
  `settings.json` `hiddenSkills` leaves named skills out of the catalog; their
  files stay readable by path.
- The preamble drops the workspace tree drawing and the SKILL.md template, and
  no longer mentions the removed six-hour compaction (ADR 0054).
- The harness also sets Durable's `afterFailedRun: "continue"`, so inputs that
  arrive during a failed run are answered without another message, and logs
  `onReport` reports with their type to the service log.

**Consequences.** The first use of a deferred tool in a conversation costs one
extra model call. Loading a tool appends a positional tool change, not a new
system prompt, so the cache stays warm. A tool moved in or out of the core set
changes every conversation's offered list once.
