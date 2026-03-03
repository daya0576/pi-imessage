# pi-imessage

An iMessage bot that delegates messages to the [pi coding agent](https://github.com/badlogic/pi-mono).

Inspired by [pi-mom](https://github.com/badlogic/pi-mono) (Slack bot), but for iMessage.

## Overview

pi-imessage listens to iMessage conversations and routes them to a pi agent, enabling AI-assisted responses directly in iMessage.

## Requirements

- macOS (iMessage access via local database)
- Node.js
- pi-mono / pi-coding-agent

## Data Layout

```
./data/
  ├── MEMORY.md          # Global memory
  ├── settings.json      # Global settings
  ├── skills/            # Global custom CLI tools
  └── <chat-id>/         # Each iMessage chat gets a directory
      ├── MEMORY.md      # Chat-specific memory
      ├── log.jsonl      # Full message history
      ├── context.jsonl  # LLM context
      ├── attachments/   # Shared files
      └── scratch/       # Agent working directory
```

## Status

Work in progress.
