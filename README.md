# @kingcrab/pi-imessage

A minimal and self-managing iMessage bot — powered by [pi](https://github.com/badlogic/pi-mono).

![screenshot](https://raw.githubusercontent.com/daya0576/pi-imessage/main/docs/screenshot.png)

## Features

- **Transparent**: tool calls and reasoning are sent to your iMessage chat, so you can see exactly what it's doing and why
- **Working memory & custom tools**: remembers context across sessions and creates workflow-specific CLI tools (aka "skills") for your tasks
- **Group chat aware**: distinguishes DMs, SMS, and group chats; identifies who sent each message
- **Web UI**: browse chat history, toggle replies on/off per chat, live updates — disable with `WEB_ENABLED=false` and let the agent build your own web UI

## Quick Start

Prerequisites: macOS with Messages.app, Full Disk Access for the terminal, [Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#quick-start) authenticated

```bash
npm install -g @kingcrab/pi-imessage

pi-imessage             # run in foreground
pi-imessage install     # install as launchd service (auto-start on boot, restart on crash)
```

## Usage

### Web UI

Available at `http://localhost:7750` (configurable via `WEB_PORT`).

- Displays chat logs from the last 7 days, sorted by most recent activity
- Toggle reply on/off per chat
- Live updates via SSE when new messages arrive

### Commands

Send these as iMessage to interact with the bot:

| Command | Description | Example Reply |
|---|---|---|
| `/new` | Reset the session, starting a fresh conversation | `✓ New session started` |
| `/status` | Show session stats: tokens, context, model | `💬 3 msgs - ↑7.2k ↓505 1.1%/128k`<br>`🤖 anthropic/claude-sonnet-4 • 💭 minimal` |

### Settings (`WORKING_DIR/settings.json`)

All fields are optional.

```json
{
  "chatAllowlist": {
    "whitelist": ["*"],
    "blacklist": ["iMessage;-;+11234567890"]
  }
}
```

**Chat allowlist** controls which chats receive replies (messages are always logged). Resolution priority: `blacklist[guid]` > `whitelist[guid]` > `blacklist["*"]` > `whitelist["*"]`.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WEB_ENABLED` | no | `true` | Set to `false` to disable the built-in web UI |
| `WEB_HOST` | no | `localhost` | Web UI host |
| `WEB_PORT` | no | `7750` | Web UI port |
| `WORKING_DIR` | no | `~/.pi/imessage` | Workspace directory |

## Development

```bash
npm run check        # typecheck + lint (run after code changes)
npm test             # run tests
```

## How It Works

```
  ~/Library/Messages/chat.db
        │
  (poll every 2s for new rows)
        │
        ▼
┌──────────────────────────────────────────────────┐
│              pi-imessage                         │
│                                                  │
│  Watcher (chat.db polling)                       │
│    │                                             │
│    ├─ Filter: is_from_me=0, no reactions         │
│    ├─ Deduplicate via seenRowIds                 │
│    ├─ Read attachments from local disk           │
│    │                                             │
│    ▼                                             │
│  AsyncQueue<IncomingMessage>                     │
│    │                                             │
│    ▼                                             │
│  SessionManager (pi-coding-agent)                │
│    │  per chatGuid, persistent on disk           │
│    │  └─ data/<chatGuid>/                        │
│    │       ├─ log.jsonl      (full history)      │
│    │       └─ context.jsonl  (LLM context)       │
│    │                                             │
│    ▼                                             │
│  Agent loop (pi-agent-core)                      │
│    │                                             │
│    │  ┌─ outer: follow-up messages ────┐         │
│    │  │  ┌─ inner: tool calls +      ┐ │         │
│    │  │  │  steering messages        │ │         │
│    │  │  └───────────────────────────┘ │         │
│    │  └────────────────────────────────┘         │
│    │                                             │
│    ▼                                             │
│  Collect assistant reply text                    │
│    │                                             │
│    ├─ sendMessage (AppleScript → Messages.app)   │
│    └─ save logs (messages, digests)              │
│                                                  │
└──────────────────────────────────────────────────┘
        │
        ▼
  iMessage (user receives reply via Messages.app)
```
