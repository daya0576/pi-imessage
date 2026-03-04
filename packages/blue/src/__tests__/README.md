# Tests

Unit tests for the Blue package.

## Test Cases

| Test Suite | Case | Description |
|------------|------|-------------|
| webhook filtering | ignores self-sent messages (isFromMe=true) | Skips self-sent messages to avoid loops |
| webhook filtering | ignores messages without text | Skips null or whitespace-only text |
| webhook filtering | ignores non new-message events | Only processes `new-message` type |
| webhook filtering | dispatches valid inbound messages | Routes valid messages to `onMessage` callback |
| createIMessageBot | normal flow: dispatches message to agent and sends reply | Full pipeline: receive → agent → send |
| createIMessageBot | self-chat: bot reply echo is suppressed | Echo filter prevents bot from replying to itself |
| bb client | sendMessage — POSTs to correct endpoint | Constructs correct URL, body, and tempGuid |
| bb client | sendMessage — throws on non-ok response | 4xx/5xx/timeout all throw errors |
| bb client | sendTypingIndicator — does not throw on failure | Typing indicators are best-effort |
| bb client | sendReaction — POSTs to /message/react | Correct fields sent for reactions |
| createSelfEchoFilter | detects echo of a remembered message | Matches and consumes registered text |
| createSelfEchoFilter | consumes entry — identical human follow-up not suppressed | One-time consume semantics |
| createSelfEchoFilter | matching is case-insensitive and trims whitespace | Normalisation applied before compare |
| createSelfEchoFilter | allows same text after TTL expires | Entries expire after configured TTL |
| createSelfEchoFilter | handles multiple chats independently | Per-chat buckets don't interfere |

## Running

```bash
npx vitest run
```
