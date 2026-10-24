# pi-imessage

A minimal, self-managing iMessage bot powered by [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

<img height="420" src="docs/screenshot.png" />

## Features

- **Minimal**: No BlueBubbles or webhook setup. Runs directly on your Mac alongside Messages.app.
- **Messages**: DMs, SMS, and group chats, with sender identification and reply context.
- **Self-managing**: The agent builds its own tools, with native web search, page fetch, and a [conversation-owned browser](docs/browser.md).
- **Web UI**: Chat history, native task state, scheduled jobs with their latest ten executions, logs, memory, and configuration.
- **Memory**: Searchable, traceable records; corrections preserve history. See [structured memory](docs/memory.md).

## Quick Start

> Just point your Pi coding agent at this README and ask it to set up pi-imessage.

Prerequisites: macOS with Messages.app, Node.js 22.22.2 or newer, Python 3
(shared memory writer), Full Disk Access for the terminal, and an authenticated
[Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#quick-start).

```bash
npm install -g @kingcrab/pi-imessage

pi-imessage             # run in foreground
pi-imessage install     # write a launchd job; loading it is a separate operator action
```

Enable replies for your chats by adding their GUIDs to the [settings allowlist](#settings).
For installation and service operations, see [ops/README.md](ops/README.md).

## Commands

Send these commands as iMessages:

| Command | Description |
|---|---|
| `/help` | List commands |
| `/new` | Cancel current work and start a fresh conversation |
| `/status` | Show tokens, context usage, and model |
| `/thinking <level\|default>` | Set thinking for this chat or follow the default |
| `/compact` | Compress context without replaying prior work |
| `/run <duration> [task]` | Keep working for up to the given time, e.g. `/run 1h`; `/stop` ends it early |
| `/stop` | Abort current work and stop `/run`; later messages are still answered |
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

Add chat GUIDs to `whitelist` to enable replies; `blacklist: ["*"]` blocks replies
elsewhere. An explicit blacklist entry takes priority. Messages are always logged.
Rich text is optional; `markdown: true` renders bold spans in direct iMessage chats.

### Workspace extensions and scheduler

Context compaction runs every six hours as a native Durable background task.
Personal tools, tasks and optional daily/interval schedules live in
`WORKING_DIR/extensions/<name>/index.ts` with `config.json`, not framework
settings. Startup and `/reload` load them; the assistant can use
`reload_extensions` to apply its own changes.

See [workspace extensions](docs/workspace-extensions.md) for the factory contract
and scheduling rules.
One-off runs use the same scheduler: declare a stable `runRequests` ID, target
schedule and `at: "now"` (or epoch milliseconds) in the extension configuration,
then call `reload_extensions`. No restart or separate execution API is needed.

Times use the service machine's local timezone. Saved deadlines survive reload
and restart; view schedules and latest-ten execution history at `/scheduled`.

### Model policy

Optional `settings.json` fields, applied at startup and `/reload`:

```json
{
  "modelPolicy": {
    "fallback": { "provider": "your-provider", "modelId": "your-model" },
    "codexServiceTier": "default"
  }
}
```

Without a fallback, an unavailable default fails explicitly. Without a tier,
provider requests are unchanged. `codexServiceTier` accepts `default` or
`priority`; priority may have a different cost. Existing deployments migrate
their previous choices into explicit configuration rather than silently changing
behavior.

### Environment Variables

All variables are optional.

| Variable | Default | Description |
|---|---|---|
| `WEB_ENABLED` | `true` | Set to `false` to disable the built-in web UI |
| `WEB_HOST` | `localhost` | Web UI host |
| `WEB_PORT` | `7750` | Web UI port |
| `WORKING_DIR` | `~/.pi/imessage` | Workspace directory |

### Web and API

See the [HTTP API](docs/api.md) for read-only state and model health checks.
The agent sends files and extra messages with `send_message`. The scheduler
provides daily/interval cadence and one-off triggers for workspace tasks, plus built-in six-hour compaction.
It does not revive legacy cron files or HTTP prompt/send endpoints.

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

## Layout

This repository is the framework; `WORKING_DIR` is one deployment's data and
code. Personal tasks and model policy live in `WORKING_DIR`; message flow lives
in the framework, run from a fixed [release checkout](ops/README.md#release-directories).
See [workspace extensions](docs/workspace-extensions.md), ADR 0036 and ADR 0042.

```text
pi-imessage/                      framework, shared by every deployment
├── src/
│   ├── main.ts, cli.ts           startup, wiring, launchd install
│   ├── web/                      read-only HTTP API and pages
│   ├── agent/                    Durable harness, models, prompt, delivery, scheduler
│   ├── extensions/               built-in tools, workspace extension loader
│   ├── transport/                chat.db polling, Messages.app sending
│   └── config/                   settings, environment, chat allowlist
├── docs/                         architecture and ADRs (the design ground truth)
├── examples/workspace-extensions/ reference extensions to copy into a workspace
├── ops/                          deployment, preflight and smoke scripts
└── test/

WORKING_DIR/  (default ~/.pi/imessage)   one deployment, back it up yourself
├── settings.json                 chat allowlist, model policy
├── extensions/<name>/            personal tools, tasks and schedules
├── skills/file-memory/           structured memory store and core summary
├── durable/                      conversation state; never edit by hand
├── attachments/                  archived incoming files
└── service.log
```

## Development

See [AGENTS.md](AGENTS.md) for development rules,
[architecture](docs/architecture.md) for the module layout and execution flow,
and [ADRs](docs/adr/) for design decisions.
