# Research Notes 

## Dependencies

### pi-mono coding-agent

Agent runtime with tool calling and state management:

```
pi-mom
└── pi-coding-agent
    ├── pi-agent-core
    │   └── pi-ai
    └── pi-tui
```

Key capabilities:
- pi-coding-agent
    - Session management (persistence, branching, compaction)
    - Extension system 
    - Skills & Prompt Templates 
    - Built-in tools (Read, Write, Edit, Bash)
- pi-agent-core
    - Event-driven agent loop (nested loop: follow-up msg + tool calls & steering msg)
    - Tool execution framework
    - Context window management
- pi-ai
    - LLM provider integration (Anthropic, OpenAI, ...)
- pi-tui
    - TUI with diff rendering


Event workflow:
```
pi starts
  │
  └─► session_start
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first, bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while LLM calls tools) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (can modify messages)            │       │
  │   │                                            │       │
  │   │   LLM responds, may call tools:            │       │
  │   │     ├─► tool_call (can block)              │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_execution_end                 │       │
  │   │     └─► tool_result (can modify)           │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  └─► agent_end                                            │
                                                           │
user sends another prompt ◄────────────────────────────────┘
```

reference:
1. https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent


## Applications

### pi-mom

Slack bot that delegates messages to the pi coding agent.

Key capabilities:
- Sandbox execution (Docker recommended; host mode available)
- Persistent workspace 
    - conversation history
    - ...

```
./data/                         # Your host directory
  ├── MEMORY.md                 # Global memory (shared across channels)
  ├── settings.json             # Global settings (compaction, retry, etc.)
  ├── skills/                   # Global custom CLI tools mom creates
  ├── C123ABC/                  # Each Slack channel gets a directory
  │   ├── MEMORY.md             # Channel-specific memory
  │   ├── log.jsonl             # Full message history (source of truth)
  │   ├── context.jsonl         # LLM context (synced from log.jsonl)
  │   ├── attachments/          # Files users shared
  │   ├── scratch/              # Mom's working directory
  │   └── skills/               # Channel-specific CLI tools
  └── D456DEF/                  # DM channels also get directories
      └── ...
```

references:
1. https://github.com/badlogic/pi-mono/tree/main/packages/mom


### openclaw


## references:
1. https://docs.openclaw.ai/channels/bluebubbles#bluebubbles
2. https://github.com/openclaw/openclaw/tree/main/extensions/bluebubbles/src

