# Architecture

## 1. Packages

```text
┌────────────────────────────────────────────┐
│ 1  main.ts · cli.ts · migrate/              │
├────────────────────────────────────────────┤
│ 2  web/                                    │
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
| 3 | `agent/` | Harness, models, chat mapping, commands, delivery, prompt, `/run`, native background scheduling and maintenance. |
| 4 | `extensions/` | Built-in native tools and loading of trusted workspace business extensions. |
| 5 | `transport/` | Poll chat.db, archive attachments, send text and files through Messages.app. No agent logic. |
| 6 | `config/` | Settings, environment variables and chat allowlist. |

Enforcement: `test/architecture.test.ts`. Rationale: [ADRs](adr/).

Personal tool and task code lives under `WORKING_DIR/extensions/<name>/index.ts` with
its own `config.json`. Startup and `/reload` scan direct child directories. Native
CommonJS module factories (`module.exports`) receive the pinned Durable primitives;
the loader never scans skills or attachments, installs dependencies or adapts SDK
extensions. Source and configuration reload without interrupting current calls.
Failed reloads retain old definitions and schedule configuration. Removed task
code stays in memory for calls that can still admit children; missing required
code fails explicitly on restart. The assistant's `reload_extensions` tool uses
the same service owner. See [workspace extensions](workspace-extensions.md),
ADR 0035 and ADR 0036.


### Native schedules

`agent/scheduling.ts` registers an extension with native task definitions. A
job's dedicated conversation owns a background scheduler, whose checkpoint saves
the next deadline. Each occurrence is a child execution task delegating to an
extension's native business task; terminal receipts supply Web history, not a
parallel UI log. The framework owns daily/interval cadence, non-overlap, recovery
and quiet six-hour native compaction. Workspace tasks own business policy and
documents, and can commit their state and the generic outgoing item atomically.
The host delivery poll uses existing direct-send receipts and passive chat records.
`web/schedules.ts` projects these native records, including latest-ten history.
Daily slots and learning dates use the service machine's local timezone; the Web
view uses the same timezone. Saved absolute deadlines survive restart. See
[ADR 0032](adr/0032-native-background-schedules.md) and
[ADR 0034](adr/0034-machine-local-schedule-time.md).

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
