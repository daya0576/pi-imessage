# Features

## Messaging
- [x] DM/Group/SMS messages
- [x] Handle attachments (images)
- [ ] Typing indicators
- [ ] Reactions
- ...

## Web Page
- [x] Display message History 

##  Message History

- [x] Store message history persistently
- [x] Review messages in web page with realtime preveiew
- [ ] Send messages in web page


## Events (Scheduled Wake-ups)
- [x] Persistent one-time reminders
- [x] Independent checkpointed nightly reflection skill/host job (existing deployments retained; no duplicate service runner)

## Skills
- [x] Enabled domain skills discovered through the shared Pi resource loader
- [x] Existing domain reflection workflows retained

## Memory
- [x] Structured memory v2
- [x] Reflection and ordinary memory writes share the canonical structured-memory backend
- [x] Bounded current `SYSTEM.md` summary and separate operational history

## Sandbox



# References:
- https://github.com/badlogic/pi-mono/blob/c65de34e11f114b53a5210f96c9b8d9bcdc80ac1/packages/agent/src/agent-loop.ts#L116C39-L116C57
- https://github.com/openclaw/openclaw/tree/main/extensions/bluebubbles/src
