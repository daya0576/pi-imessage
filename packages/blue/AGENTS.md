# Development Rules

## Knowledge Base

- When working on tasks involving pi-mono internals, message handling, or architecture decisions,
read `docs/pi-mono.md` before proceeding.

## Never

- Never over-engineer — no abstractions until needed. Functions > classes. No DI frameworks.
- Never put multiple concerns in one file — split by feature if beyond ~200 lines.

## Always

- Always keep modules minimal: `bb.ts` (BB API), `store.ts` (persistence), `agent.ts` (agent lifecycle), `server.ts` (HTTP), `log.ts` (logging), `main.ts` (entry).
- Always respond 200 to webhooks immediately, process async (fire-and-forget).
- Always queue incoming messages per chatGuid when agent is busy.
- Always use env vars: `BLUEBUBBLES_URL`, `BLUEBUBBLES_PASSWORD`, `ANTHROPIC_API_KEY`, `BLUE_PORT` (default 3100), `BLUE_DATA_DIR` (default ./data).