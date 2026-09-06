Busy-only text batching (v1)

Idle chats start immediately. While a chat is processing a turn, consecutive pending messages from the same sender can become one model input. Other chats remain concurrent.

<img width="1000" alt="A1 and A2 form one batch; B1 and A3 remain separate, preserving sender boundaries and order." src="https://raw.githubusercontent.com/daya0576/pi-imessage/8aab11190b3127dd283f2724cd25992f3512ebfb/issue-23/02-sender-boundary.png">

Only non-empty plain text from a known sender is eligible. Slash-prefixed messages, quotes, attachments, loaded images, and sender/chat metadata changes split batches. At most eight messages and 8,000 UTF-16 code units (including separators) can be joined. Larger individual messages still run unchanged.

The active turn never absorbs new input. The next batch is frozen before processing. Each original runs through logging, echo filtering, storage, and preparation separately; surviving texts are joined with two newlines for one agent call. No synthetic joined incoming entry is written to the chat log. Streaming and tool replies are unchanged: one agent call may still emit multiple outgoing messages.

/stop still bypasses the per-chat queue. A boundary marker prevents messages from opposite sides of /stop from merging. It does not introduce cancellation of already-pending messages.

No debounce, steering, silence policy, model switch, automatic batch replay, or new production setting. The HTTP automation path is unchanged. Existing agent retry and send semantics remain unchanged; this does not add durable in-flight acknowledgement or exactly-once delivery across crashes.

Tests cover immediate start, busy-only merging, sender and content boundaries, independent chats, limits, stop boundaries, error isolation, original-message logging, echo filtering, log-only settings, and command dispatch. Integration tests use the actual bot/pipeline with a mocked agent and sender, not live model or Messages calls.

Related experiment: https://github.com/daya0576/pi-imessage/issues/23
