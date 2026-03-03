# blue (iMessage bot)

> Pi also is a collection of little components that you can build your own agent on top. That's how OpenClaw is built, and that's also how I built my own little Telegram bot and how Mario built his mom. If you want to build your own agent, connected to something, Pi when pointed to itself and mom, will conjure one up for you. - Pi: The Minimal Agent Within OpenClaw

An minimal iMessage bot powered by an LLM that can execute bash commands, read/write files, and interact with your development environment. Blue is self-managing. She installs her own tools, programs CLI tools (aka "skills") she can use to help with your workflows and tasks, configures credentials, and maintains her workspace autonomously.

# Features

## [WIP] Messaging

Key capabilities:
- Direct messages / group chats
- Mentions
- Typing indicators
- Reactions
- Send attachments
- ...

How it works:
```
  BlueBubbles Server
        │
  (webhook POST: new-message)
        │
        ▼
┌──────────────────────────────────────────────────┐
│             Blue Server (HTTP)                   │
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

Dependencies:
```
blue
 ├─ @mariozechner/pi-agent-core   (Agent loop, steering, tool execution)
 ├─ @mariozechner/pi-coding-agent (SessionManager for persistence)
 └─ @mariozechner/pi-ai           (getModel)
```

Env vars: `BLUEBUBBLES_URL` / `BLUEBUBBLES_PASSWORD` 

TODO:
- [ ] Handle message images
- [ ] Process different chats (DMs / group messages) concurrently

## [WIP] Message History

Key capabilities:
- Store message history persistently
- Review messages in web page

## [WIP] Sandbox

## [WIP] Memory

## [WIP] Skills

## [WIP] Events (Scheduled Wake-ups)
