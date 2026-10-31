# 0057. Prompt section changes travel as user messages

Status: proposed (owner asked for the change and the diff, 2026-10-31, #49)

**Problem.** Durable stores a changed prompt section in place, but every model we run lacks `supportsMidConvoSystemMessages`, so pi-ai merges it into the leading system message. The prefix changes and each active chat rewrites its whole prompt cache once (group max, 2026-10-31 09:28:36: read 0, wrote 158,726 tokens). Rule tuning, such as asking for more interim messages (ADR 0056), therefore costs a full cache write per chat.

**Example.**

```text
Stored:    [sys v1] [u1] [a1] ... [sys update] [u51]
Sent now:  [sys v1+update] [u1] [a1] ... [u51]                  prefix changed
Sent new:  [sys v1] [u1] [a1] ... [user <prompt_update>] [u51]   prefix kept
```

**Decision.**

- `withModelPolicy` rewrites the request for a model without `supportsMidConvoSystemMessages`: the leading system message stays as stored; each later system entry's content and sections become one user message `<prompt_update>` at the same position, rendered by pi-ai's `renderSystemMessageUpdate` and marked as a host update. Tool deltas stay on a system entry, since tools are a separate request field.
- Models with the flag are unchanged.
- `<prompt_update` in chat input is renamed to `<prompt_update_quoted` so a sender cannot forge one.
- The interim rule (ADR 0056) asks for one short sentence with each tool call, or at least every two or three calls.

**Consequences.** A section change costs only its own tokens on the next request. Updates accumulate until the context resets; often-edited sections (SYSTEM.md) grow the transcript with each edit. Tool output can still contain the tag; it is not a trust boundary for tool results. Tests read sections through a helper that understands both forms.
