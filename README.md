# @kingcrab/pi-imessage

A minimal and self-managing iMessage bot — powered by [pi](https://github.com/badlogic/pi-mono).

<img height="420" src="https://raw.githubusercontent.com/daya0576/pi-imessage/main/docs/screenshot.png" />

# Features
- **Minimal**: No BlueBubble, no webhooks, no extra dependencies
- **Self-managing**: Turn the agent into whatever you need. He builds his own tools without pre-built assumptions
- **Transparent**: tool calls and reasoning are sent to your iMessage chat, so you can see exactly what it's doing and why
- **iMessage Integration**: Responds to DMs, SMS, and group chats; identifies who sent each message; understands quoted/reply-to messages
- **Web UI**: browse chat history, toggle replies on/off per chat, live updates — disable with WEB_ENABLED=false and let the agent build your own web UI

# Get Started

> ⚠️ **Security note**
> - Replies are **off** for all chats by default (`blacklist: ["*"]`) — only explicitly whitelisted chats get a response
> - The agent runs with Full Disk Access and can read/write your filesystem as part of its tool use
> - The web UI has no authentication and is accessible to anyone on your local network; set `WEB_ENABLED=false` if that's a concern

Prerequisites: macOS with Messages.app, Full Disk Access for the terminal, [Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#quick-start) authenticated

```bash
npm install -g @kingcrab/pi-imessage

pi-imessage             # run in foreground
pi-imessage install     # install as launchd service (auto-start on boot, restart on crash)
```

# Usage

## Web UI

Available at `http://localhost:7750` (configurable via `WEB_HOST` and `WEB_PORT`).

- Chat history with live updates
- Logs (tail -f style)
- Memory (global & per-chat)

P.S. Disable with `WEB_ENABLED=false` and let the agent build your own web UI

## API

The agent is aware of these endpoints via its system prompt and can use them as tools (e.g., scheduling a cron job that calls `/prompt`).

| Endpoint | Description | Example |
|---|---|---|
| `POST /send` | Send a raw iMessage to a chat (bypasses the agent) | `curl -X POST localhost:7750/send -d '{"chatGuid": "iMessage;-;+11234567890", "text": "hello"}'`<br>→ `{"ok": true}` |
| `POST /prompt` | Feed a prompt to the agent asynchronously; replies are sent to the chat when ready | `curl -X POST localhost:7750/prompt -d '{"chatGuid": "iMessage;-;+11234567890", "prompt": "say hello"}'`<br>→ `{"ok": true}` |

## Commands

Send these as iMessage to interact with the bot:

| Command | Description | Example Reply |
|---|---|---|
| `/help` | List available slash commands | `Commands:`<br>`/help — list commands` |
| `/new` | Reset the session, starting a fresh conversation | `✓ New session started` |
| `/status` | Show session stats: tokens, context, model | `💬 3 msgs - ↑7.2k ↓505 1.1%/128k`<br>`🤖 anthropic/claude-sonnet-4 • 💭 minimal` |
| `/compact` | Compress session context to free up token space | `✓ Compacted: 15.2k → 2.1k tokens` |
| `/stop` | Steer the agent to stop after current tool calls finish, then process the next queued message | |
| `/reload` | Reload models and clear all sessions | `✓ Models reloaded` |

## Settings (`WORKING_DIR/settings.json`)

All fields are optional.

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

**Chat allowlist** controls which chats receive replies (messages are always logged). By default, replies are **off** for all chats (`blacklist: ["*"]`) — opt in specific chats via the web UI or by adding their guid to `whitelist`. Resolution priority: `blacklist[guid]` > `whitelist[guid]` > `blacklist["*"]` > `whitelist["*"]`.

**Rich text** is optional and disabled by default. When enabled, pi-imessage uses a UI automation fallback to open the target conversation, paste an RTF payload, and send it. Currently this is intended for direct-message iMessage chats. With `markdown: true`, pi-imessage interprets `**bold**` spans and renders them as actual bold text in Messages.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WEB_ENABLED` | no | `true` | Set to `false` to disable the built-in web UI |
| `WEB_HOST` | no | `localhost` | Web UI host |
| `WEB_PORT` | no | `7750` | Web UI port |
| `WORKING_DIR` | no | `~/.pi/imessage` | Workspace directory |

# Development

```bash
npm run check        # typecheck + lint (run after code changes)
npm test             # run tests
```

# How It Works

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
