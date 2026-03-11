# blue (iMessage bot)

> Pi also is a collection of little components that you can build your own agent on top. That's how OpenClaw is built, and that's also how I built my own little Telegram bot and how Mario built his mom. If you want to build your own agent, connected to something, Pi when pointed to itself and mom, will conjure one up for you. - Pi: The Minimal Agent Within OpenClaw

An minimal iMessage bot powered by an LLM that can execute bash commands, read/write files, and interact with your development environment. Blue is self-managing. She installs her own tools, programs CLI tools (aka "skills") she can use to help with your workflows and tasks, configures credentials, and maintains her workspace autonomously.



# Quick Start

## Development

Prerequisites: [BlueBubbles](https://bluebubbles.app/) running on macOS, pi authenticated (`~/.pi/agent/auth.json` exists).

```bash
# 1. Set BlueBubbles webhook → http://localhost:7749/webhook (New Messages only)

# 2. Install & configure
npm install
cp .env.example .env
# Edit .env: set BLUEBUBBLES_PASSWORD

# 3. Start
npm run dev
```

# Usage

## Web UI

Available at `http://localhost:7750` (configurable via `WEB_PORT`).

- Displays chat logs from the last 7 days, sorted by most recent activity
- Toggle reply on/off per chat 

## Commands

Send these as iMessage text to interact with Blue:

| Command | Description | Example Reply |
|---|---|---|
| `/new` | Reset the session, starting a fresh conversation | `✓ New session started` |
| `/status` | Show session stats: tokens, context, model | `💬 3 msgs - ↑7.2k ↓505 1.1%/128k`<br>`🤖 github-copilot/gpt-5-mini • 💭 minimal` |

## Settings (`WORKING_DIR/settings.json`)

All fields are optional.

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4.6",
  "defaultThinkingLevel": "minimal",
  "chatAllowlist": {
    "whitelist": ["*"],
    "blacklist": ["iMessage;-;+11234567890"]
  }
}
```

`chatAllowlist` controls which chats receive replies (messages are always logged). Resolution priority: `blacklist[guid]` > `whitelist[guid]` > `blacklist["*"]` > `whitelist["*"]`. The example above replies to everyone except one number.

