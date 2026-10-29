# 0055. A large chat context idle for an hour starts fresh on the next message

Status: accepted (2026-10-30; the owner specified the rule and asked for it to be implemented and deployed, in chat)

Complements ADR 0054: the window still bounds a chat's context, but a chat that has gone quiet does not carry a large stale context into its next topic.

**Problem.** After ADR 0054 nothing shortens a chat context until Durable's threshold compaction near the window. A chat that ended a long task and is picked up hours later for an unrelated question pays for the whole old context (prefill, cache miss, slower first token) and the model keeps old working state in view. The owner wants the context dropped in that case without having to type `/new`.

**Example.** The last assistant message of a chat reports `usage.totalTokens` 95k at 14:02. At 16:30 a message arrives: the host resets the context and then submits the message, so the model sees only the system prompt and the new message. Had the message arrived at 14:40, or had the context been 40k, it would have been appended as usual.

**Decision.** Before submitting an ordinary message to a chat that has no active `/run`, the host reads the chat's committed context once, as `/status` does, and looks at its last message. If that message is an assistant message whose usage reports more than 60k context tokens and whose `timestamp` is more than one hour before now, the host calls `Conversation.reset()` and then submits the message. The thresholds are constants in `agent/chats.ts`. No timer, task or schedule is added. The reset is logged with the conversation, the token count and the idle minutes.

**Consequences.** The check costs one Durable context read per inbound message. It only fires at a turn boundary: during a run or ordinary work the last context message is a user message or tool result, so a busy chat is never reset; a message arriving mid-turn is steered as before. The history keeps the old context behind the `pi.reset` marker, so nothing is deleted. A chat below 60k stays intact however long it idles, and a large chat keeps its context while messages arrive within the hour. Timestamps are the model request start, so an hour is measured from the last request, not the last reply.

**Rejected.** A timer that resets idle chats (the six-hour compaction's problems, ADR 0054). `settings.json` thresholds (no second user of the knob yet; constants are enough). A compaction instead of a reset (keeps a summary the owner does not want after an hour). A handoff summary on reset (same reason).
