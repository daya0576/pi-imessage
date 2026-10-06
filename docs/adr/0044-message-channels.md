# 0044. Organize message sources as channels

Status: proposed

**Problem.** `transport/` is iMessage-only: it polls `chat.db` and sends through
Messages.app. A second message source, such as Telegram, has no place to go, and
the name "transport" suggests a network layer. `transport/http.ts` is the shared
outgoing HTTP client, not a message source.

**Example.** Adding Telegram today would mean putting `telegram-watch.ts` beside
`watch.ts`, while `agent/` imports `MessageSender` from the iMessage `send.ts`.

**Decision.** Apply this when the second channel is implemented, not before
(no abstraction until needed):

- Rename `transport/` to `channels/`, with one directory per channel:
  `channels/imessage/` (`watch.ts`, `send.ts`, `rich-text.ts`,
  `attachments.ts`), `channels/telegram/`, and so on.
- Put the shared contract in `channels/types.ts`: the incoming message shape and
  `MessageSender`. `agent/` depends on this contract, never on one channel.
- Move the process HTTP client (ADR 0016) out of the channel package, for example
  to `config/` or a small `net/` package at the bottom layer.
- Identify chats as `<channel>:<id>` for new channels. Existing iMessage chat
  GUIDs stay unchanged, so `settings.json` allowlists and Durable `Chats`
  records remain valid.

**Consequences.** One rename and an import update when the second channel
arrives; until then the code stays as it is. The layer rule (ADR 0002) is
unchanged: channels stay below `agent/` and contain no agent logic.

**Rejected.** A generic plugin loader for channels: there is one real channel
today, and workspace extensions (ADR 0042) already cover tool plugins.
