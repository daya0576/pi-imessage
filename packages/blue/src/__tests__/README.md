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
| before phase | passes message through when all before-tasks return it | Tasks chain correctly |
| before phase | drops message when a before-task returns null | Null short-circuits pipeline |
| before phase | short-circuits on first null | Later before-tasks are skipped |
| before phase | runs before-tasks in registration order | Sequential execution |
| start phase | returns the reply from the start-task | Reply flows through |
| start phase | returns null when no start-task is registered | Empty start is safe |
| end phase | receives message and reply | Both values passed to end-task |
| end phase | receives null reply when start-task returns null | Null reply forwarded |
| end phase | is skipped when before-task drops the message | No end on filtered msg |
| end phase | runs end-tasks in registration order | Sequential execution |
| createLogIncomingTask | passes the message through unchanged | Pass-through semantics |
| createLogIncomingTask | logs DM with sender | Correct DM format |
| createLogIncomingTask | logs group with group name and sender | Correct group format |
| createLogIncomingTask | logs SMS with SMS label | Correct SMS label |
| createDropSelfEchoTask | drops a message that matches a remembered echo | Echo detection works |
| createDropSelfEchoTask | passes through a message that is not an echo | Non-echo passes |
| createDropSelfEchoTask | passes through a message with no text | Image-only safe |
| createCallAgentTask | delegates to agent.processMessage and returns reply | Agent delegation |
| createCallAgentTask | returns null when agent returns null | Null reply |
| createSendReplyTask | sends reply and remembers echo | Send + echo memory |
| createSendReplyTask | does nothing when reply is null | Null reply is no-op |
| createLogOutgoingTask | logs the outgoing reply | Correct log format |
| createLogOutgoingTask | does not log when reply is null | Null reply is silent |
| createLogOutgoingTask | logs group reply with group name | Correct group format |

## Running

```bash
npx vitest run
```
