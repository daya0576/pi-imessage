# 0047. One scheduling path for recurring and one-off work

Status: accepted (owner requested the minimal implementation on 2026-10-06)

## Problem

Recurring workspace jobs currently enter through a native scheduler task, while
`serve --run-scheduled JOB --request-id ID` calls `runOnce()` and creates an
occurrence directly. Both use Durable, but admission follows two paths, and a
manual trial requires a service restart.

Calling all work "scheduled" is not sufficient. The common path must own deadline
persistence, deduplication and non-overlap. A trial must also retain the original
job's business state, rather than create an empty English learning history or
bypass the monthly quota.

## Example

Workplace English has a daily 07:45 trigger. An operator requests one trial now.
The trial receives its own stable trigger ID, but targets the existing English
job and business conversation. Reloading twice does not run it twice, and the
regular 07:45 deadline does not move. Existing per-date card deduplication still
applies: a trial is not permission to resend today's card.

## Evaluation

- **One common scheduling path:** recommended. Recurrence and an immediate trial
  differ in their deadlines and repetition, not their executor or delivery path.
- **One physical configuration file:** unnecessary. Keep trusted business code
  and configuration in the workspace extensions required by ADR 0042. Their
  declarations pass through one framework admission function.
- **Automatic configuration polling:** unnecessary for the first version. The
  existing `reload_extensions` tool and `/reload` already apply configuration
  through the owning service without restart. Polling would add partial-write,
  repeated-load and failure-handling concerns without helping deadline execution.
- **A local CLI/socket or HTTP run API:** unnecessary here. A trial can be a
  one-off declaration followed by the existing reload. This trades one explicit
  reload operation for avoiding another control protocol.
- **A separate business executor for every cadence:** rejected. Reminder,
  script and model workflows remain native business tasks; they do not become
  separate schedulers.

## Decision

### One admission and execution path

```text
Workspace extension configuration
                |
      startup / reload_extensions / /reload
                |
       validate and register triggers
                |
       native background Scheduler task
                |
       sleep(persisted absolute deadline)
                |
       native occurrence wrapper
                |
       registered native business task
                |
       native receipts -> read-only Scheduled Web
                |
       optional outbox -> existing send receipts
```

The reload commands are configuration-loading entry points, not direct execution
paths. No file edit alone invokes business work. An immediate trial becomes due
once its declaration has been accepted; it is not a promise of zero latency.
The service must be running, and publication of validated code/configuration must
complete before newly due work can execute under that definition.

The framework retains one owning Harness. Do not introduce another daemon,
operating-system timer, SDK scheduler bridge, database, or polling watcher.

### Job identity and trigger identity

- A **job** names registered business code, input, destination and its existing
  business conversation/state. It is not an arbitrary command or prompt supplied
  by a new public execution API.
- A **trigger** names when that job is eligible to run. Recurring triggers and
  one-off triggers use the same registration function and scheduler definition.
- The minimal version preserves elapsed-time intervals and one local daily slot,
  and adds a one-off absolute deadline or `now`. Multiple daily slots and monthly
  calendars are deferred, not part of this first change. Do not add a cron parser.
- Resolve `now` to an absolute timestamp once, in the admission transaction.
  Persist the stable trigger ID, target job and deadline together. Subsequent
  reloads/restarts recover that trigger, including a terminal one; they never
  reevaluate `now`. A new intended trial needs a new trigger ID. Conflicting reuse
  of a one-off ID fails explicitly.
- A one-off declaration targets an existing registered job. Do not give it a
  fresh business conversation, reset learning/checkpoints, or change the regular
  trigger's deadline. A workspace extension must provide this declarative trial
  binding; trial requests do not require generating a new extension per run.
- Enforce non-overlap by target job, not merely by trigger. A due one-off can wait
  for that job's active occurrence, then admit its own occurrence. Do not report
  another trigger's work as completion of the new request.
- Commit occurrence admission and the scheduler checkpoint together. A one-off
  scheduler becomes terminal after its occurrence; a recurring scheduler saves
  the next deadline. Failures remain visible in native occurrence records.

### Recovery, reload and delivery

- Preserve ADR 0042's machine-local calendar/DST rules, saved absolute deadlines,
  daily/interval overdue behavior and lack of historical backfill. A one-off
  admitted before shutdown runs once when overdue after restart.
- Load and validate a complete candidate before accepting declarations. A failed
  reload leaves old definitions and schedules active and must not start a trial.
  Reload does not interrupt existing business calls. Pausing/removing a declaration
  prevents future admission, not undoing already admitted effects.
- Use native task versions/migrations where persisted structures change. Preserve
  existing job/conversation/task IDs, learning state, checkpoints, execution
  history and delivery receipts. Do not recreate terminal trials on startup.
- Business tasks keep their own replay and success policy under ADR 0041. A shared
  clock does not make a script's external effects transactional or replay-safe.
  Reflection advances its checkpoint and starts backup only after verified success.
- Keep the existing outgoing queue and at-most-once transport receipts. An
  interrupted send becomes `unknown` and is not automatically resent. One-off
  execution does not override a business quota, per-date dedupe or a send receipt.
- Reuse the compact Scheduled page and native occurrence history. Show one-off
  executions under their target job, with links to their Task tree. Viewing the
  page starts no work; add no execution buttons.

### Entry points removed or deferred

After the unified one-off path is available, remove the operator startup-run
flags and the direct-occurrence `runOnce()` bypass. Keep their historical request
and execution records; do not replay them during migration. Do not add a CLI or
Unix socket replacement.

ADR 0045 remains a separate proposal about chat scheduling tools. This ADR does
not enable or reject those tools. If accepted, their declarations must use this
same admission/clock/occurrence path, preserve chat ownership boundaries, and
must not introduce another scheduler or call a business executor directly.

## Scope and consequences

Framework changes concern the schedule declaration contract, common admission,
calendar calculation, scheduler lifecycle and removal of the operator bypass.
Personal messages, weather/news logic, memory updates, photo-date checks and
Reflection remain workspace extensions, not framework-specific branches.

Restoring the selected legacy jobs uses this path. Stop only their competing old
cron producers during the authorized cutover; do not disable unrelated system
jobs. Fixed-message business tasks do not restore the retired reminder service,
PT workers or HTTP `/prompt` / `/send`. No restoration or migration is performed
by accepting a file reload alone
unless those jobs are explicitly declared.

The first version requires an explicit reload after editing configuration. This
is intentional: it avoids a new watcher and a new management service. Persistence
cannot wake a stopped process or machine. Exactly-once external delivery is not
claimed.

This supersedes only ADR 0042's operator-run clause (which
consolidated ADR 0033), and extends its cadence/declaration contract. Its workspace
ownership, recovery and delivery rules remain in force. Accepted ADRs stay
unchanged.
