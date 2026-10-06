# 0023. Retain progress type prefixes

Status: accepted (owner explicitly corrected the format on 2026-10-05)

Supersedes the prefix-free display examples of ADR 0022 only. Admission,
settlement, privacy, elapsed time and receipt/recovery behavior are unchanged.

**Problem.** Arrows and checkmarks replaced useful type labels. The owner wants
bracketed prefixes retained alongside the new status markers.

**Example.** `[tool] → bash: 搜索上海天气`, followed by `[tool] ✓ bash (0.8s)`.
Owned child tools use `[subagent/tool] → read: path=…` and
`[subagent/tool] ✓ read (0.8s)`. Native non-tool tasks retain `[task]` and
parent-qualified task prefixes. Unsuccessful settlement uses `×`.

**Decision.** Render the native type/parent prefix first, then the status marker,
then the native tool/task name and short safe summary or elapsed time. Do not
restore timeout, raw shell commands or clickable URLs.
