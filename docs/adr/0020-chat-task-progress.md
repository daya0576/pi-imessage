# 0020. Report native task calls in iMessage

Status: accepted (owner approved the format, exclusions, implementation and restart)

**Problem.** Final-only replies leave the owner unable to see tool and task
progress in iMessage while work is running.

**Example.** A search emits `[tool] web_search · query=上海浦东 私立医院`
before the final answer. Other custom tasks emit their native task name. A
foreground subagent's calls use `[subagent/tool]` and go to its parent chat.

**Decision.**

- Observe committed native task admission with Durable's public commit API;
  do not wrap tools, poll task phases or introduce another execution loop.
- With `settings.json` setting `progressMessages: true`, send one plain-text
  notice per new task to its owning, reply-enabled chat, except `pi.generation`
  which the owner excludes. A `pi.tool` task is one tool notice, not a duplicate
  task notice. Keep IDs internal for deduplication; do not display them.
- Include native names, parent names and bounded argument summaries, not tool
  outputs, thinking, free-form commands, prompts or document contents. Path and
  search-query previews are screened for known credential indicators; URL
  previews omit user info, paths, queries and fragments. Arbitrary user-authored
  secrets cannot be guaranteed detectable.
- Follow Durable's conversation ownership for child/subagent attribution.
  Health and unrelated ownerless conversations stay local.
- Use existing direct-send receipts keyed by task ID. Unknown sends are not
  retried. Do not replay pre-existing live tasks on startup or generate model
  context entries for progress notices.
- Notifications do not gate task execution; drain admitted notices before
  automatic final replies. Stop observation and join pending sends on shutdown.
- Missing or false configuration retains final-only delivery. No stored
  settings or receipt formats are removed.

**Consequences.** iMessage can receive many notices. Progress reflects task
admission, not confirmed completion. Final answers retain their existing
reconciliation and at-most-once rules. This expands final-only chat behavior;
accepted ADR files remain unchanged. Scope and validation belong in GitHub #33.

**Rejected.** Asking the model to narrate every call, forwarding raw outputs,
replaying old task history, or using unreliable delivery confirmation to retry.
