# @kingcrab/pi-imessage

A minimal, self-managing iMessage bot powered by [pi](https://github.com/earendil-works/pi) and [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

<img height="420" src="docs/screenshot.png" />

## Features

- **Messages**: DMs, SMS, and group chats, with sender identification and reply context. No BlueBubbles or webhook setup.
- **Self-managing**: The agent builds its own tools, with web search, page fetch, and browser access through native tools and skills.
- **Web UI**: Live chat history, scheduled tasks and results, logs, memory, and configuration.
- **Memory**: Searchable, traceable records; corrections preserve history. See [structured memory](docs/memory.md).
- **Quiet operation**: Results go to chat; diagnostics stay in local logs.

## Quick Start

Prerequisites: macOS with Messages.app, Node.js 22.22.0 or newer, Python 3
(shared memory writer), Full Disk Access for the terminal, and an authenticated
[Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#quick-start).

```bash
npm install -g @kingcrab/pi-imessage

pi-imessage             # run in foreground
pi-imessage install     # install as launchd service (auto-start on boot, restart on crash)
```

Enable replies for your chats by adding their GUIDs to the [settings allowlist](#settings).

## Commands

Send these commands as iMessages:

| Command | Description |
|---|---|
| `/help` | List commands |
| `/new` | Cancel current work and start a fresh conversation |
| `/status` | Show tokens, context usage, and model |
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

### Scheduled Tasks and API

Configure recurring jobs in `WORKING_DIR/cron/jobs.json`, with `send`, `prompt`,
or `exec` actions. See [scheduled tasks](docs/scheduling.md) for configuration
and one-time reminders.

The [HTTP API](docs/api.md) supports sending messages, triggering the agent,
managing scheduled tasks, and checking model health.

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
