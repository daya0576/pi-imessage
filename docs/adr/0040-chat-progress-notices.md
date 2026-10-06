# 0040. Chat progress notices

Status: proposed (consolidates ADRs 0020–0028 and 0031 without changing behavior)

**Problem.** The current progress format is spread over ten ADRs that each
replace a detail of the previous one.

**Example.**

```text
→ [tool] bash: node search.mjs "Shanghai weather" --count 5
✓ [tool] bash (0.8s)
→ [subagent/tool] read: path=/tmp/a.jpg
× [subagent/tool] read (0.1s)
```

**Decision.**

- With `settings.json` `progressMessages: true`, observe native task admission
  and settlement through Durable's commit subscription. No wrapper, polling or
  second execution loop. `pi.generation` tasks are not reported.
- Send one request notice at admission and one response notice at settlement,
  to the owning reply-enabled chat. Child tasks follow Durable ownership and are
  labelled with their parents, such as `[subagent/tool]`. Health and unrelated
  ownerless conversations stay quiet.
- Format: status marker first (`→` request, `✓` success, `×` anything else),
  then `[parents/type]`, then the native name. Success requires a completed task
  and a tool result without an error flag. Responses show elapsed time from
  admission, including queueing.
- Bash requests show the command inline, at most 120 Unicode code points. Screen
  the whole command first: a credential indicator hides it, and URLs and common
  domains are defanged so iMessage shows no link preview. Other tools show
  bounded argument summaries; URLs show only a defanged hostname; timeouts are
  omitted. Never show outputs, thinking, prompts or document contents.
- Six-hour maintenance compaction is quiet. Manual `/compact` and Durable's
  automatic threshold/overflow compactions are reported.
- `src/agent/progress-format.ts` holds a transport-independent `ProgressEvent`
  and pure formatting and screening functions; iMessage is one adapter.
- Each notice uses a direct-send receipt keyed by task ID. Unknown sends are not
  retried, and work admitted before startup is not replayed. Final replies wait
  for queued notices first.

**Consequences.** A busy turn sends many notices. Screening is best effort and
cannot detect every secret. This supersedes ADRs 0020–0028 and 0031.
