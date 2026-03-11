# sid (iMessage Agent)

Your best iMessage friend — powered by [pi](https://github.com/badlogic/pi-mono).


## Features 

- Self managing: Installs tools, writes scripts, configures credentials. Zero setup from you
- Transparent: Tools calls and reasining are forwarded to your iMessage chat, so you can see exactly what Sid is doing and why
- Web UI: browse chat history, toggle replies on/off, live updates


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

## How it works

## Usage

### Web UI

Available at `http://localhost:7750` (configurable via `WEB_PORT`).

- Displays chat logs from the last 7 days, sorted by most recent activity
- Toggle reply on/off per chat
- Live updates via SSE when new messages arrive

### Commands

Send these as iMessage to interact with Sid:

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
  },
  "modelOverride": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4",
    "defaultThinkingLevel": "minimal"
  }
}
```

**Chat allowlist** controls which chats receive replies (messages are always logged). Resolution priority: `blacklist[guid]` > `whitelist[guid]` > `blacklist["*"]` > `whitelist["*"]`.

**Model override** overrides the default model from `~/.pi/agent/`. Omit to use pi defaults.

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
