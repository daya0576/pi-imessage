# HTTP API

[Back to README](../README.md)

Default address: `http://localhost:7750` (configured by `WEB_HOST` and `WEB_PORT`).
The server has no authentication; do not expose it to untrusted networks.

The agent is aware of these endpoints via its system prompt and can use them as tools (e.g., scheduling a cron job that calls `/prompt`).

| Endpoint | Description | Example |
|---|---|---|
| `POST /send` | Send text and/or a local file attachment to a chat (bypasses the agent) | `curl -X POST localhost:7750/send -d '{"chatGuid": "iMessage;-;+11234567890", "text": "hello"}'`<br>→ `{"ok": true}` |
| `POST /prompt` | Feed a prompt to the agent asynchronously; replies are sent to the chat when ready | `curl -X POST localhost:7750/prompt -d '{"chatGuid": "iMessage;-;+11234567890", "prompt": "say hello"}'`<br>→ `{"ok": true}` |
| `POST /reminders` | Schedule a persistent one-time reminder; `scheduledAt` requires an explicit timezone | `curl -X POST localhost:7750/reminders -d '{"chatGuid":"iMessage;-;+11234567890","text":"check the oven","scheduledAt":"2026-08-08T21:30:00+08:00"}'` |
| `GET /reminders` | List reminders; optionally filter with `?status=pending` | `curl 'localhost:7750/reminders?status=pending'` |
| `DELETE /reminders/:id` | Cancel a pending reminder | `curl -X DELETE localhost:7750/reminders/<id>` |
| `GET /scheduled/data` | List recurring jobs, one-time reminders, and recent recurring runs | `curl localhost:7750/scheduled/data` |
| `POST /cron/jobs/:id/run` | Run a configured recurring job immediately | `curl -X POST localhost:7750/cron/jobs/morning-message/run` |
| `POST /cron/jobs/:id/enabled` | Pause or resume a recurring job and atomically update the workspace config | `curl -X POST localhost:7750/cron/jobs/morning-message/enabled -d '{"enabled":false}'` |
| `GET /health/model` | Make a live request to the configured default AI model; returns HTTP 200 when healthy or 503 on failure | `curl localhost:7750/health/model`<br>→ `{"ok":true,"model":"openai/gpt-5","latencyMs":842,"checkedAt":"..."}` |
