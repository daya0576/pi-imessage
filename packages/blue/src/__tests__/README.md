# Tests

Unit tests for the Blue package.

## Test Cases

| Test Suite | Case | Description |
|------------|------|-------------|
| webhook filtering | should ignore isFromMe messages | Skips self-sent messages to avoid loops |
| webhook filtering | should ignore messages without text | Skips null or whitespace-only text |
| webhook filtering | should ignore non new-message events | Only processes `new-message` type |
| webhook filtering | should dispatch valid messages to agent | Routes valid messages to `agent.processMessage` |
| store | should create session managers per chatGuid | Same chatGuid → same instance, different → different |
| bb client | should construct proper API calls | Client creates without errors, has expected methods |
| logger | should write structured log lines | Writes JSON log entries with level, message, and metadata |

## Running

```bash
npx vitest run
```
