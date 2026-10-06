# Workspace extensions

Memory, web tools, chat routing and delivery remain built-in capabilities.
Business code belongs in `WORKING_DIR/extensions/<name>/index.ts` with its own
`config.json`. Both the operator and chat assistant can create it. This is trusted
host code, not a sandbox or an SDK `ExtensionAPI` adapter. Back up the extension
directories with their configuration. The
[system-context](../examples/workspace-extensions/system-context/) example loads
an optional workspace summary into the prompt (ADR 0036).

Tools without `replay` rerun after an interruption (ADR 0039). Declare
`replay: "unsafe"` for an effect that must not repeat.

## Factory and reload

Use a CommonJS factory (`module.exports`) and CommonJS local dependencies
(`require`); put `{"type":"commonjs"}` in the extension's `package.json`.
Erasable TypeScript and type-only imports are supported. Runtime ESM modules
cannot be cache-evicted safely and are not part of this reload contract.
No dependencies are installed by the loader.

```ts
module.exports = ({ config, defineExtension, defineTask }) => {
  const Tick = defineTask({
    name: "example.tick",
    version: 1,
    initial: () => ({ phase: "work" }),
    phases: {
      async work(task, runtime, context) {
        await runtime.commit(() => ({
          status: "terminal",
          outcome: { status: "completed", result: {
            summary: config.summary,
            finishedAt: runtime.now()
          } }
        }), context);
      }
    },
    async abort(task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    }
  });
  return {
    ...defineExtension({ name: "example", tasks: [Tick] }),
    schedules: [{ id: "example-tick", name: "Example tick", enabled: true,
      intervalMs: 3600000, task: Tick.definition.name }]
  };
};
```

The factory receives `workingDir`, parsed `config`, `Type`, `defineExtension`,
`defineTool`, `defineDoc`, `defineTask`, `configure`, `section`, and the generic
`ScheduledOutbox` document token. All primitives are the host's pinned versions.
Return a native extension with optional `schedules`; tools and multiple tasks
work without any schedules. Startup and `/reload` scan direct, non-hidden child
directories only, never skills or attachments. `reload_extensions` lets the chat
assistant apply its changes through the existing service owner, without sending
an iMessage or opening a second Harness.

Extension names, task names and schedule IDs must be unique. Schedule IDs are
stable state keys, not display names. Failed validation or initialization keeps
old definitions and schedule configuration. Reload refreshes CommonJS entry and
local dependency code plus configuration. Running invocations keep their code;
subsequent invocations use the replacement. Increment task versions and supply
native `migrate` handlers for changed saved inputs/checkpoints.

## Scheduling and delivery

A schedule requires `id`, `name`, `enabled`, and a `task` name belonging to its
extension. Choose exactly one cadence: `time: "HH:MM"` or positive `intervalMs`.
Optional fields: `kind` (display metadata), `chatGuid` and JSON `input`.
An optional `initialize(tx, conversationId)` imports business state within the
host's atomic schedule commit. It must be replay-safe and must not send messages
or perform external writes; use native tasks for external actions.

The framework creates a dedicated conversation and background scheduler for each
schedule. Each occurrence delegates to the business task with:

- `jobId`, `date` (machine-local), `dueAt`, `startedAt`;
- `chatGuid` or null, and `config` containing the schedule's JSON `input` or null.

Successful business tasks return `{ summary, finishedAt, requestId? }`.
The wrapper's native receipt supplies read-only `/scheduled` history.
Daily schedules process only today's slot, without missed-date backfill;
interval schedules skip missed slots. Automatic and manual occurrences do not
overlap. Reload never resets a saved absolute deadline: new cadence applies
when computing the following slot. An explicitly aborted scheduler is not
silently recreated.

Commit business changes and `ScheduledOutbox.items` together, using a stable
`requestId`. The host reuses its direct-send receipts and passive chat records.
The destination must be reply-enabled. `sending`/`unknown` effects are never
replayed automatically; a queued item is not proof of delivery. Keep credentials
out of `settings.json`; the schedule view does not show extension configuration.

## One-off runs through the same scheduler

For an existing factory that does not declare `runRequests`, the loader takes
that field directly from `config.json`; business code need not change. A factory
can instead explicitly supply its own `runRequests` declarations alongside its
`schedules`. For example, the extension's `config.json` can include:

```json
{
  "runRequests": [
    { "id": "example-trial-1", "scheduleId": "example-tick", "at": "now" }
  ]
}
```

Apply the configuration with `reload_extensions` (or the existing `/reload`).
The target must be an enabled schedule belonging to that extension. `at` is
`"now"` or an absolute epoch-millisecond timestamp. There is no configuration
watcher or separate CLI/HTTP execution entry point.

The owner persists a background `imessage.schedule` task for the request, then
uses the same occurrence wrapper and business conversation as recurring runs.
A busy target delays the one-off until its active occurrence settles. The request
ID and resolved deadline survive reload/restart, including after completion.
Reuse the same declaration to recover it; use a new ID for a new intended run.
Conflicting reuse fails rather than changing an existing request.

Removing a request prevents future admission, not an already admitted business
task. Re-adding a consumed ID never runs it again. Business per-date dedupe and
delivery receipts still apply; a trial does not force another English card.
Regular task IDs and deadlines do not move. Historical operator runs remain
stored, but startup `--run-scheduled` flags are no longer accepted.

Removing an extension disables future schedule admission and removes its tools
and prompt sections, not current calls or historical records. Removed task code
is conservatively retained in memory until restart, because an old running call
can still admit children. Restart fails explicitly if unfinished work needs
missing task code or a missing schedule extension.
