# Architecture

## 1. Packages

```text
┌────────────────────────────────────────────┐
│ 1  main.ts · cli.ts · migrate/              │
├────────────────────────────────────────────┤
│ 2  web/ · scheduler/ · automation/          │
├────────────────────────────────────────────┤
│ 3  agent/                                  │
├────────────────────────────────────────────┤
│ 4  extensions/                             │
├────────────────────────────────────────────┤
│ 5  transport/                              │
├────────────────────────────────────────────┤
│ 6  config/                                 │
└────────────────────────────────────────────┘
         Imports go downward only.
```

### Notes

These are folders under `src/`, not separate npm packages.
The root `main.ts` and `cli.ts` files form one host package. `migrate/` is a
separate top-layer executable: the CLI invokes it by process argv, not an import.
Lower layer numbers may import higher ones. Different packages in the same layer
cannot import each other; imports within a package are allowed.

| Layer | Package | Responsibility |
|---|---|---|
| 1 | `main.ts`, `cli.ts` | Startup, wiring and installation. |
| 1 | `migrate/` | One-time history import; writes directly to Durable storage. |
| 2 | `web/` | HTTP API; read-only pages for chat history and live state. |
| 2 | `scheduler/` | Cron jobs and one-time reminders. |
| 2 | `automation/` | PT browser tasks. |
| 3 | `agent/` | Harness, models, chat mapping, commands, delivery, prompt, `/run` and scheduled compaction. |
| 4 | `extensions/` | Native tools: memory, subagents, image reading, web search and page fetch. |
| 5 | `transport/` | Poll chat.db, archive attachments, send text and files through Messages.app. No agent logic. |
| 6 | `config/` | Settings, environment variables and chat allowlist. |

Planned enforcement: `test/architecture.test.ts`. Rationale: [ADRs](adr/).


## 2. Workflow

### Overall flow

```text
User (iMessage / SMS)
        |
        v
transport/watch.ts
  Poll chat.db, filter, save attachments
        |
        v
agent/chats.ts
  Find conversation; submit with GUID as requestId
  Save row cursor after acceptance; steer if busy
        |
        v
Pi Durable Harness <--------> durable/ (JSONL)
        |                          |
        | final answer             +--> web/ (history and live state)
        v
agent/deliver.ts
  Record sending -> transport/send.ts -> record sent
                           |
                           v
                      Messages.app -> User
```

Each chat has its own conversation. `/stop` aborts current work.
Only final answers go to chat; commentary and diagnostics stay local.
After a restart, unfinished sends become `unknown`, never automatically resent.
The web UI reads through Harness APIs, not directly from JSONL files.

### Inside the Harness

These concepts and files are native to Pi Durable's JSONL storage.
Paths are relative to `WORKING_DIR/durable/`.

| Member | Role | File |
|---|---|---|
| Conversation | Conversation scope linking history and tasks. | `main.jsonl` |
| Generation | Requests the model, waits for tools and advances one model turn. | Active: `task-<id>.jsonl`; terminal: `main.jsonl` |
| Entry | Immutable history record: user input, model response or tool result. | `main.jsonl` |
| `pi.live` | Current run state, partial model response and running tool output. | `doc-<id>.jsonl` |
| `pi.inbox` | Queued submissions received while the conversation is busy. | `doc-<id>.jsonl` |

Example: "Show the current directory.", then a `steer` while the tool runs.
Based on a verified Durable 1.0.2 run; test timing details are omitted.
The second Generation is not shown. File mappings are in the table above.

```text
Conversation / Tasks                                                      Model                 Tool
|                                                                           |                     |
| Conversation 1 (main.jsonl) - create                                      |                     |
|                                                                           |                     |
|   Generation task (task-9.jsonl)                                          |                     |
|     ▶ phase=prepare; state=pending                                        |                     |
|       pi.live - run.taskId=9, inputs=[8]                                  |                     |
|       Prepare request; Entry 10 (main.jsonl) - pi.system                  |                     |
|     ▶ phase=request; state=running                                        |                     |
|       pi.live - generation.attempt=1                                      |                     |
|       ------------------ request with committed context ------------------>                     |
|       <------------------ complete response: bash call -------------------|                     |
|       Entry 11 (main.jsonl) - pi.assistant, byTaskId=9                    |                     |
|       pi.usage - update model usage                                       |                     |
|     ▶ phase=tools; state=waiting, on=[12]                                 |                     |
|       pi.live - clear partial; tool 12 pending                            |                     |
|                                                                           |                     |
|     Tool Task T12 (task-12.jsonl), owner=9                                |                     |
|       ▶ phase=call; state=pending                                         |                     |
|         Resolve tool; validate arguments                                  |                     |
|       ▶ phase=execute; state=running                                      |                     |
|         Save arguments + replay=unsafe; pi.live tool running              |                     |
|         -------------------------------- execute command="pwd" --------------------------------->
|         <----------------------------- result: current directory -------------------------------|
|         Entry 14 (main.jsonl) - pi.tool-result, byTaskId=12               |                     |
|                                                                           |                     |
|       ▶ T12 (main.jsonl): state=terminal, outcome=completed               |                     |
|         pi.live - tool done, entry=14; clear output                       |                     |
|                                                                           |                     |
|     ▶ phase=tools (reused); state=running                                 |                     |
|       Place steer: Entry 15 (main.jsonl) - pi.user, byTaskId=9            |                     |
|       Submission 13 (main.jsonl) - status=placed                          |                     |
|       pi.inbox - remove item 13                                           |                     |
|                                                                           |                     |
|     ▶ G9 (main.jsonl): state=terminal, outcome=completed                  |                     |
|       pi.live - remove tools; run.taskId=16                               |                     |
|                                                                           |                     |
| Next generation continues the run; final settlement is not shown.         |                     |
|                                                                           |                     |
```

Upstream reference: [Watching a Conversation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#watching-a-conversation)
and [Busy Conversations](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#busy-conversations).
Upstream `main` is experimental; the examples here describe the pinned version.
