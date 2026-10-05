# Scheduled Tasks

[Back to README](../README.md)

## Recurring Jobs

Recurring jobs are configured in `WORKING_DIR/cron/jobs.json`. pi-imessage uses
[Croner](https://github.com/Hexagon/croner) for cron expressions and timezone
handling. Only the active worker schedules jobs; deployment shadow workers only
validate and display the configuration.

Supported actions are `send`, `prompt`, and `exec`. Exec jobs use an argv array
with an absolute executable path and never invoke a shell. `send` and `prompt`
may set `command`, the same kind of argv: its stdout replaces `text` or `prompt`,
and empty output skips the run. A `prompt` runs in a fresh task conversation; its
sent answer is recorded in the chat conversation. Jobs default to
`Asia/Shanghai`, reject overlapping runs, and append results to
`WORKING_DIR/cron/runs.jsonl`.

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "morning-message",
      "enabled": true,
      "schedule": "0 9 * * *",
      "timezone": "Asia/Shanghai",
      "action": {
        "type": "send",
        "chatGuid": "iMessage;-;+11234567890",
        "text": "good morning"
      }
    }
  ]
}
```

Use the web UI to view jobs and recent results. The [HTTP API](api.md) also
supports running a job immediately and pausing or resuming it.

## One-Time Reminders

Use `POST /reminders` to create a persistent reminder. Its `scheduledAt` value
must include an explicit timezone. List reminders with `GET /reminders` and
cancel a pending reminder with `DELETE /reminders/:id`.
See the [HTTP API](api.md) for examples.
