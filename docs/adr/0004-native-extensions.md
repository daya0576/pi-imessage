# 0004. Native Durable extensions, not an SDK adapter

Status: accepted (2026-10-04; owner accepted 2026-10-05)

**Context.** Chats need web search, page fetch and a browser. Durable has no loader for Pi SDK extensions, and the official durable coding agent loads none; its own way to add tools is `defineTool` / `section` / `defineDoc`.

**Decision.** Write the tools we use as native Durable extensions. `extensions/web.ts` provides search and readable-page fetch, with the search-result cache in a per-conversation `defineDoc` (this replaces the old `appendEntry("web-search-results")` hack and rewinds with forks and compaction). Browser work uses the `pi-browser` CLI through `bash` (the `browser` skill); no extension. We do not adapt or fork `pi-web-access` or `pi-browser-actions`. Also not loaded: `openai-codex-fast` (10 lines in `agent/harness.ts`), `claw-remote`, `tool_search` (all tools are offered directly), `pi-subagents` and `pi-goal-x` (replaced by `subagent.ts` and `/run`).

**Consequences.** `web.ts` owns its search provider and fetch dependencies (e.g. `undici`, `defuddle`, `turndown`, `unpdf`), and implements only the features the bot uses, not `pi-web-access`'s full set. No fragile `ExtensionAPI` shim to break on an upstream upgrade.

**Rejected.** A home-grown `ExtensionAPI` shim running `pi-web-access` unchanged (the old `headless-extensions.ts`: a fake context plus 30k bundled lines at runtime). Forking the extensions.
