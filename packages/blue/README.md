# blue (iMessage bot)

> Pi also is a collection of little components that you can build your own agent on top. That's how OpenClaw is built, and that's also how I built my own little Telegram bot and how Mario built his mom. If you want to build your own agent, connected to something, Pi when pointed to itself and mom, will conjure one up for you. - Pi: The Minimal Agent Within OpenClaw

An minimal iMessage bot powered by an LLM that can execute bash commands, read/write files, and interact with your development environment. Blue is self-managing. She installs her own tools, programs CLI tools (aka "skills") she can use to help with your workflows and tasks, configures credentials, and maintains her workspace autonomously.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BLUEBUBBLES_URL` | required | — | BlueBubbles server URL (e.g. `http://localhost:1234`) |
| `BLUEBUBBLES_PASSWORD` | required | — | BlueBubbles server password |
| `BLUE_PORT` | optional | `7749` | Port for the BlueBubbles webhook listener |
| `WEB_PORT` | optional | `7750` | Port for the web UI |
| `WORKING_DIR` | optional | `~/.pi/imessage` | Workspace directory for chat sessions, memory, and skills |

## Authentication

Credentials are shared with pi-coding-agent and stored in `~/.pi/agent/auth.json`.

**OAuth login** (recommended for Claude Pro/Max):

```bash
npx @mariozechner/pi-coding-agent
# then run /login → Anthropic/GitHub Copilot/... → follow browser instructions
```

**API key** via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Model Configuration

Blue uses the model from `~/.pi/agent/settings.json` (`defaultProvider` + `defaultModel`) by default.

To override, add a `model` section to `WORKING_DIR/settings.json`:

```json
{
  "model": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4.6"
  }
}
```
