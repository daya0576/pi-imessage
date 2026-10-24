# 0049. Per-chat progress notices

Status: proposed (owner-requested implementation, 2026-10-24)

**Problem.** `progressMessages` in `settings.json` turns tool progress notices on or off for every chat at once. A busy group wants only the final messages while an admin chat wants to watch the tools.

**Example.**

```text
/verbose            -> Verbose: on (default)
/verbose off        -> Verbose: off (this chat only)
/verbose default    -> Verbose: on (default)
```

**Decision.**

- Each chat record in the native `imessage.chats` document gets an optional `progress` boolean. `/verbose on|off` sets it and `/verbose default` removes it; `/verbose` alone reports the effective state. The record version is unchanged; old records have no field.
- The progress observer (ADR 0040) resolves the owning chat first and then gates both the admission and the settlement notice by `chat.progress ?? settings.progressMessages`. Reply-enabled allowlisting, formatting, screening, receipts and no-replay rules are unchanged.
- `settings.json` stays the default and is never rewritten by a command; the per-chat choice lives only in Durable.

**Consequences.** A `/verbose off` chat still runs tools and records their results; it only stops seeing the two notice lines. Child notices follow the owning chat's choice. Changing the global default does not touch chats with an explicit choice.
