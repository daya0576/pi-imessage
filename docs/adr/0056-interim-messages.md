# 0056. Interim messages between tool calls

Status: proposed (owner-requested implementation, 2026-10-31, "like verbose, a switch, on by default")

**Problem.** A long task shows only tool notices until the final answer. The
user sees what ran, not what was learned, and cannot correct course early.

**Example.**

```text
Found it: magpie returned 403 because the Copilot account does not allow Fable.
→ [tool] bash: ssh mini 'cp -p providers.json providers.json.bak …'
✓ [tool] bash (3.4s)
<final answer>
```

**Decision.**

- Text the model writes in an assistant message that also calls tools (stop
  reason `toolUse`) is an interim message. The commit observer of ADR 0040 sends
  it once with a direct-send receipt `interim:<entry id>`, queued before the
  notices of the calls in the same commit. Unknown sends are not retried and
  history is not replayed after a restart.
- Only a chat's own conversation or its `/run` conversation speaks. Subagent
  and other child conversations stay private, as do thinking and tool output.
- `settings.json` `interimMessages` sets the default; absent means on. A chat's
  `/interim on|off|default` choice lives in the `imessage.chats` record next to
  the `/verbose` choice (ADR 0049) and wins over the default.
- The chat-steer prompt states only the delivery fact: text next to a tool call
  reaches the chat at once. How often to write is left to the workspace
  AGENTS.md and the model. The text is constant, so toggling does not change
  the prompt. (Revised 2026-10-31, #49: the earlier "findings only" wording
  left 3% of tool-calling messages with text.)
- Final-answer delivery (ADR 0003, ADR 0011) is unchanged; interim messages are
  not final answers and do not appear in reply-delivery.

**Consequences.** How often a chat hears from the model depends on the model;
there is no rate limit. A long text next to a tool call is sent as is. Turning
`/interim off` restores final-only text without changing the model's behavior.
