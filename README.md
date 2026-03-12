# pi-imessage

An iMessage bot — powered by [pi](https://github.com/badlogic/pi-mono).
- **Transparent** — tool calls and reasoning are forwarded to your iMessage chat, so you can see exactly what it's doing and why
- **Web UI** — browse chat history, toggle replies on/off, live updates
- **Working memory & custom tools** — remembers context across sessions and creates workflow-specific CLI tools (aka "skills") for your tasks
- **Group chat aware** — distinguishes DMs, SMS, and group chats; identifies who sent each message

![](https://github.com/user-attachments/assets/0dbfd0ae-1e22-4c0f-8421-7b2c93cfe174)

## How It Works

```
  BlueBubbles Server
        │
  (webhook POST: new-message)
        │
        ▼
┌──────────────────────────────────────────────────┐
│          pi-imessage Server (HTTP)               │
│                                                  │
│  POST /webhook                                   │
│    │                                             │
│    ├─ Ignore isFromMe messages                   │
│    │  (skip self-sent to avoid loop)             │
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
│    ├─ sendMessage (BB REST API)                  │
│    └─ save logs (messages, digests)              │
│                                                  │
└──────────────────────────────────────────────────┘
        │
        ▼
  iMessage (user receives reply)
```


## Quick Start

Prerequisites: [BlueBubbles](https://bluebubbles.app/) running on macOS, [Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#quick-start) authenticated

```bash
# 1. Set BlueBubbles webhook → http://localhost:7749/webhook

# 2. Install & configure
npm install
cp .env.example .env
# Edit .env: set BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD

# 3. Start
./scripts/start.sh
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
| `BLUEBUBBLES_URL` | yes | - | BlueBubbles server URL |
| `BLUEBUBBLES_PASSWORD` | yes | - | BlueBubbles server password |
| `BLUE_HOST` | no | `localhost` | Webhook listener host |
| `BLUE_PORT` | no | `7749` | Webhook listener port |
| `WEB_HOST` | no | `localhost` | Web UI host |
| `WEB_PORT` | no | `7750` | Web UI port |
| `WORKING_DIR` | no | `~/.pi/imessage` | Workspace directory |

## Development

```bash
npm run check        # typecheck + lint (run after code changes)
npm test             # run tests
```
