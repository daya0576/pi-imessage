# blue (iMessage bot)

> Pi also is a collection of little components that you can build your own agent on top. That's how OpenClaw is built, and that's also how I built my own little Telegram bot and how Mario built his mom. If you want to build your own agent, connected to something, Pi when pointed to itself and mom, will conjure one up for you. - Pi: The Minimal Agent Within OpenClaw

An minimal iMessage bot powered by an LLM that can execute bash commands, read/write files, and interact with your development environment. Blue is self-managing. She installs her own tools, programs CLI tools (aka "skills") she can use to help with your workflows and tasks, configures credentials, and maintains her workspace autonomously.


# Features

## [WIP] Messaging

### Key capabilities
- [x] Direct messages
- [x] Group chats
- [ ] Mentions
- [ ] Typing indicators
- [ ] Reactions
- [ ] Send attachments
-  ...

### Key Components

- BlueBubbles Server (HTTP)
    - Webhook receiver for DM/GROUP messages
    - Filter messages from self
- IMessageBot - receives messages from BlueBubbles Server, forwards to SessionManager, sends replies
    - Maintains session state (per chatGuid)
- BlueBubbles Client (REST API):
    - Send message


## [PLAN] Message History

Key capabilities:
- Store message history persistently
- Review messages in web page


## [PLAN] Events (Scheduled Wake-ups)


## [PLAN] Sandbox

## [PLAN] Memory

## [PLAN] Skills



# References:
- https://github.com/badlogic/pi-mono/blob/c65de34e11f114b53a5210f96c9b8d9bcdc80ac1/packages/agent/src/agent-loop.ts#L116C39-L116C57
- https://github.com/openclaw/openclaw/tree/main/extensions/bluebubbles/src

