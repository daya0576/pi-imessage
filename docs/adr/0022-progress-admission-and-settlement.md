# 0022. Arrow and settlement progress notices

Status: accepted (owner requested arrow/checkmark style and omitted timeout on 2026-10-05)

Supersedes the admission-only notification/display decisions of ADR 0020 and
the displayed timeout example in ADR 0021. Other safety and routing decisions
remain unchanged.

**Problem.** Character counts and bracketed tool headers are noisy. The owner
prefers the earlier arrow/checkmark style and does not need timeout parameters
in chat.

**Example.** `→ bash: 搜索上海天气`, then `✓ bash (0.8s)` on successful settlement.
An unsuccessful call gets `× bash (0.8s)`, never a success checkmark.

**Decision.**

- Observe native committed task admission and terminal settlement through the
  existing public commit subscription, without another execution loop.
- Emit one arrow at admission and one checkmark/cross at settlement for tasks
  admitted during this process lifetime. Exclude generation tasks and retain
  native parent/child ownership, allowlist and private-health routing.
- For native tools, success requires both a completed task outcome and the
  stored tool-result message having no error flag. Aborted, failed and missing
  or error tool results are not success.
- Duration is local elapsed admission-to-settlement time, including queueing;
  it is not exact subprocess-only runtime or recipient delivery latency.
- Keep separate direct-send receipt IDs for admission and settlement. Do not
  replay historical starts/completions or retry uncertain sends after restart.
- Omit timeout from displayed argument summaries only; native enforcement is
  unchanged. Keep short screened purpose labels and non-clickable hostnames,
  never raw commands or outputs.
- Final replies drain already queued progress notices. Progress remains
  optional through the existing setting. This intentionally doubles most
  task progress notices compared with admission-only reporting.
