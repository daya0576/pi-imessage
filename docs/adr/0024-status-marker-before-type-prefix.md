# 0024. Status marker before the type prefix

Status: accepted (owner explicitly corrected marker placement on 2026-10-05)

Supersedes the prefix-first display order in ADR 0023 only. Preserve all
native routing, safe descriptions, settlement verification and receipt rules.

**Example.** `→ [tool] bash: Check the weather`, then `✓ [tool] bash (0.8s)`.
Child tools use `→ [subagent/tool] read: path=…`. Failure uses `×` first.

**Decision.** Put the status marker at the very beginning, immediately followed
by the retained bracketed type/parent label. Ask for short everyday action
wording instead of implementation jargon. Omit timeout and raw commands.
