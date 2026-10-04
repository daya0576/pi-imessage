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
Lower layer numbers may import higher ones. Different packages in the same layer
cannot import each other; imports within a package are allowed.

| Layer | Package | Responsibility |
|---|---|---|
| 1 | `main.ts`, `cli.ts` | Startup, wiring and installation. |
| 1 | `migrate/` | One-time history import; writes directly to Durable storage. |
| 2 | `web/` | HTTP API, chat history, live state and controls. No actions on page load. |
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

Harness = storage + execution. Agent = model + configuration.
A tool is a model-callable capability; a task is a durable unit of work;
a phase is a step within a task.

```text
submit(input)
     |
     v
Inbox
  |
  v
  +--> pi.generation task: prepare phase <---------------+
  |      Build system prompt, select tools               |
  |      Compact context if needed                      |
  |               |                                     |
  |               v                                     |
  |    request phase: ONE model request                 |
  |               |                                     |
  |               +-- final answer -> finish this turn   |
  |               |                                     |
  |               +-- tool calls -> tools phase          |
  |                                    |                |
  |                                    v                |
  |                               pi.tool task          |
  |                                 Validate args       |
  |                                 Run hooks           |
  |                                 Execute tool        |
  |                                    |                |
  |                                    v                |
  |                               Save tool result      |
  |                                    |                |
  |                                    +----------------+
  |                                      Next generation
  |                                      sees tool results

Available tools: CodingTools / native extensions
  Skills and CLI (e.g. pi-browser) run via read/bash.
  A tool may explicitly create a custom task:
    phase -> commit checkpoint -> next phase / finish

Task checkpoints, entries and documents -> JSONL storage
Restart: open storage + harness.resume() -> resume pending work
```

**Prepare:** call each prompt section's function to get its current text
(e.g. rules, AGENTS.md, skill descriptions or saved task state). These pieces
form the system prompt; "render" means generating text, not drawing a UI.
Durable records prompt/tool changes in the conversation, checks whether
compaction is needed, and saves a checkpoint for the request phase.

**Request:** read the prepared context, run `beforeRequest` hooks, then call
the model. Its response determines whether to execute tools, finish, or retry.

Source: [`prepare`](https://github.com/earendil-works/pi/blob/70eceaade630d348aa42ca3e4ff3b785dad80754/packages/durable/src/harness/generation.ts#L126-L184)
and [`request`](https://github.com/earendil-works/pi/blob/70eceaade630d348aa42ca3e4ff3b785dad80754/packages/durable/src/harness/generation.ts#L185-L209).

- **Automatic:** Durable creates generation/tool tasks and advances their phases;
  the model chooses which tools to call. We implement tool logic, not another agent loop.
- **Explicit:** custom tasks must be created by host/tool code; registering them
  does not run them. The host schedules cron and 6-hour compaction.
- **Recovery:** interrupted tools rerun only when their replay policy permits it.
  Custom task phases must make repeated external effects safe; checkpoints alone do not.

Reference: [Reading Pi Durable](https://changchen.me/blog/20261003/pi-durable/),
checked against Durable's task examples and generation/tool implementation.
