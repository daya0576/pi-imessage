# @kingcrab/pi-imessage

A minimal, self-managing iMessage bot powered by [pi](https://github.com/earendil-works/pi) and [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

<img height="420" src="docs/screenshot.png" />

## Features

- **Messages**: DMs, SMS, and group chats, with sender identification and reply context. No BlueBubbles or webhook setup.
- **Self-managing**: The agent builds its own tools, with web search, page fetch, and browser access through native tools and skills.
- **Web UI**: Chat history, native task state, scheduled jobs with their latest ten executions, logs, memory, and configuration.
- **Memory**: Searchable, traceable records; corrections preserve history. See [structured memory](docs/memory.md).
- **Quiet operation**: Results go to chat; diagnostics stay in local logs.

## Quick Start

Prerequisites: macOS with Messages.app, Node.js 22.22.0 or newer, Python 3
(shared memory writer), Full Disk Access for the terminal, and an authenticated
[Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#quick-start).

```bash
npm install -g @kingcrab/pi-imessage

pi-imessage             # run in foreground
pi-imessage install     # write a launchd job; loading it is a separate operator action
```

Enable replies for your chats by adding their GUIDs to the [settings allowlist](#settings).
Installation, history import, authorized cutover and rollback follow [ops/README.md](ops/README.md);
do not run old and new pipelines together.

## Commands

Send these commands as iMessages:

| Command | Description |
|---|---|
| `/help` | List commands |
| `/new` | Cancel current work and start a fresh conversation |
| `/status` | Show tokens, context usage, and model |
| `/thinking <level\|default>` | Set thinking for this chat or follow the default |
| `/compact` | Compress context without replaying prior work |
| `/stop` | Abort current work and stop `/run`; later messages are still answered |
| `/run <duration> [task]` | Keep working for up to the given time, e.g. `/run 1h`; `/stop` ends it early |
| `/reload` | Refresh models/auth, AGENTS, skills and extensions without cancelling work |

## Configuration

### Settings

Edit `WORKING_DIR/settings.json`. All fields are optional.

```json
{
  "chatAllowlist": {
    "whitelist": ["iMessage;-;+11234567890"],
    "blacklist": ["*"]
  },
  "richText": {
    "enabled": false,
    "markdown": true
  }
}
```

**Chat allowlist**: Add chat GUIDs to `whitelist` to enable replies. Messages are
always logged. Priority: `blacklist[guid]` > `whitelist[guid]` > `blacklist["*"]` >
`whitelist["*"]`.

**Rich text**: Disabled by default and intended for direct iMessage chats.
When enabled, UI automation opens the conversation, pastes RTF, and sends it.
With `markdown: true`, `**bold**` spans become bold text in Messages.

### Native schedules

Six-hour quiet chat compaction is a Durable background task. To enable the daily
English card, add this startup-only setting and restart the service safely:

```json
{
  "scheduledEnglish": {
    "enabled": true,
    "chatGuid": "iMessage;-;+11234567890",
    "time": "07:45",
    "historyFile": "/absolute/path/to/work-english-expressions/used.json"
  }
}
```

The clock uses Asia/Shanghai. Learning history is imported once, read-only;
subsequent progress and generated cards live in Durable. Daily selection keeps
at most two reviews and one eligible new expression per day, reviews first,
and at most ten new expressions in a
rolling thirty-day window, with at least three days between new-learning dates.
The destination must remain reply-enabled. Saved sends use at-most-once receipts;
`unknown` is never automatically retried. Missed timer slots do not create a
backlog of historical cards; already admitted work and its outbox remain durable.
See the read-only `/scheduled` page for all configured native jobs, their next
deadline and the latest ten executions. Legacy cron files remain inert.

### Environment Variables

All variables are optional.

| Variable | Default | Description |
|---|---|---|
| `WEB_ENABLED` | `true` | Set to `false` to disable the built-in web UI |
| `WEB_HOST` | `localhost` | Web UI host |
| `WEB_PORT` | `7750` | Web UI port |
| `WORKING_DIR` | `~/.pi/imessage` | Workspace directory |
| `AGENT_IDLE_TIMEOUT_MS` | `120000` | Abort after this much continuous inactivity; model and tool events reset the timer |
| `AGENT_MAX_PROMPT_DURATION_MS` | `1800000` | Absolute time limit for one prompt, independent of activity |

### Web and API

The [HTTP API](docs/api.md) provides read-only chat state and an explicit model
health check. The agent sends files and extra messages with `send_message`.
Only configured daily English and six-hour compaction schedules are supported.
Arbitrary delayed/recurring prompts, reminders, background completion notifications
and PT Automation remain unsupported; independent system jobs are not managed here.

## How It Works

```text
Messages chat.db → Watcher → Pi Durable → Messages.app
```

Each chat has its own conversation, persisted under `WORKING_DIR/durable/`.
Durable resumes pending work after a crash. Agent replies are sent at most once;
uncertain send results are flagged, never automatically resent.

Context is compacted silently every 6 hours and near the model's limit. Failed
compaction keeps the old context. `/new` starts fresh without deleting searchable
history.

## Development

See [AGENTS.md](AGENTS.md) for development rules,
[architecture](docs/architecture.md) for the module layout and execution flow,
and [ADRs](docs/adr/) for design decisions.
