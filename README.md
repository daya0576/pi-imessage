# OpenSesame

An iMessage agent powered by [pi](https://github.com/badlogic/pi-mono). Open sesame — your messages, answered.

## Packages

| Package | Description |
|:---:|:---:|
| `web` | A minimal web component for conversation management. |
| `sid` | The iMessage bot core — a puppet (like Cookie Monster, the blue Muppet) that bridges users and the LLM. |
| `bluebubble` | Assembles unified messages from webhooks; sends replies via BlueBubbles server. |
| `otg` | Assembles unified messages by polling the local iMessage SQLite database; sends replies via AppleScript. Also known as Oscar the Grouch — lives in the trash (local db), gets things done. |

> integrations (`bluebubble` / `otg`) are mutually exclusive — pick one.
