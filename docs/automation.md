# Automation Tasks (minimal POSIX worker)

This is a generic reviewed-driver scheduler, **not a browser integration**. No browser runner, credentials, personal targets, or live job configuration are included.

## Reviewed configuration

An operator creates `WORKING_DIR/automation/jobs.json`; absent file means no jobs. Configuration is read only at process creation (restart after review; no hot reload or web editing). Example, with placeholder paths that must be replaced by a reviewed local driver:

```json
{
  "version": 1,
  "jobs": [{
    "id": "hourly-check",
    "name": "Hourly service check",
    "enabled": true,
    "schedule": "0 * * * *",
    "timezone": "Asia/Shanghai",
    "timeoutSeconds": 120,
    "argv": ["/absolute/path/to/node", "/absolute/path/to/reviewed-driver.cjs"],
    "cwd": "/absolute/path/to/driver-workspace",
    "chatGuid": "operator-reviewed-notification-target"
  }]
}
```

All fields except `cwd` and `chatGuid` are required. IDs match `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`. Executable and optional cwd must be absolute; timeout is positive and at most 3600 seconds. Croner validates schedule/timezone. `argv` is passed unchanged with `shell:false`; no UI-provided arguments are accepted. File permissions, executable review, and workspace ownership are the operator's responsibility. Do not configure the same driver in the legacy cron service too.

A driver exits zero and emits a final nonblank stdout line containing exactly:

```json
{"status":"healthy","summary":"Verification passed"}
```

Status is `healthy`, `needs_human`, or `failed`; optional `reason` is a string. Extra keys, malformed results, spawn errors, or nonzero exits fail. Only the final 8192 characters are buffered; stderr is discarded. No raw output or child exception is logged, returned, or persisted. Summary/reason are control-character filtered, capped at 500 characters, and common credential assignments / known config values are redacted. **This is not a general secret detector: drivers must emit only public, non-sensitive summaries**, never URLs containing credentials, cookies, page dumps, or exception text. No personal details belong in job names either.

Drivers must perform bounded checks/relogin attempts, emit `needs_human` for challenges or intervention, and stop. They must not detach descendants, create daemons, or arrange later writes. Resume invokes this same verification driver; it never declares recovery without a healthy result.

## State and cancellation

`automation/automation.db` (SQLite WAL) persists tasks, runs, and notification outbox. Start runs only with the active worker lifecycle, alongside cron; shadow workers reject mutations. Use **one active worker per workspace**, not multiple independent service instances.

Only one execution per task runs at once. Pause takes effect immediately but retains the lock while cancellation completes. POSIX children form a process group; cancellation/timeout sends SIGTERM, then SIGKILL after a one-second grace, verifying group absence and awaiting child close before release. A late healthy result cannot override cancellation. Leftover processes after normal driver completion fail the run and are terminated. Unverified termination persists a blocked flag and refuses every rerun, including Resume.

Human handoff, manual pause, and interrupted shutdown/restart require Resume. Failed Resume remains paused. Regular failures/timeouts may be checked again on schedule. Startup marks interrupted running records failed; it never signals persisted PIDs (PID reuse risk). If a persisted group still exists or PID is unknown, task remains blocked. An operator must independently verify all previous processes have ended, stop the worker, and clear that task's `blocked` flag in SQLite before Resume is possible; no web override is provided.

Next schedule and last success survive restarts. At most one overdue check runs on startup per enabled, unpaused task, then scheduling advances to the future. Paused checks do not replay. Disabled config jobs cannot Run or Resume. History API exposes the last 100 runs, but SQLite history is not automatically pruned.

## Notifications

`createAutomationService({workingDir, notify})`: `notify(chatGuid, text): Promise<void>` must be bounded and reject on submission failure. Main calls the existing sender (and echo filter). Text sending currently confirms only AppleScript submission, **not delivery**. UI/outbox states are `pending` / `accepted`, never `delivered`.

One failure/handoff notice per incident, one recovery notice when healthy; normal healthy hourly checks produce no notices. Failed sends remain pending and retry at most three total attempts, no sooner than one minute later (persisted across restart). Exhausted notices remain pending for operator inspection; absent callback/target also remains pending. Send acceptance followed by process crash can lead to a duplicate on retry: the existing sender has no idempotency or delivery acknowledgment API. There is no false exactly-once delivery guarantee. Daily 21:00 Asia/Shanghai summary is **not implemented**.

## Web/API

- `GET /tasks`: escaped Eta mobile-friendly status, controls, and recent runs.
- `GET /tasks/data`: `{tasks, runs}` with explicit public columns only; no argv, cwd, chatGuid, config file contents, PID, or raw logs.
- `POST /tasks/{safe-id}/run|pause|resume`: body `{}`, headers `Content-Type: application/json`, `X-Automation-Action: 1`, and `Origin` exactly matching `http://Host`. Cross-site fetch metadata is rejected; no CORS. Maximum body 1024 bytes. 202 means queued/accepted, not successful execution. 409 means unavailable/paused/blocked/unknown task; 403 origin/header rejection; 404 invalid route; 503 absent service. Poll GET for results.

No authentication was added to the existing server. Keep it loopback-only or behind authenticated, appropriately secured access. Origin checks are CSRF protection, not authentication. HTTPS reverse-proxy mutations are deliberately not accepted through forwarded headers in this MVP. Only fixed reviewed jobs execute; no command/config editing endpoints exist.

## Validation

Tests create temporary workspaces and harmless child scripts. They cover result validation, secret/config exclusion, HTML escaping, human pause and verified recovery, notification persistence/retry, overlap, pause, timeout with SIGTERM-resistant descendants, shutdown, interrupted restart, catch-up, async API, cross-origin rejection, bounded body and ID traversal. They make no browser/network-service requests or real sends (HTTP tests use an ephemeral loopback server).

Run `npm run check`, `node_modules/.bin/vitest run`, and `node_modules/.bin/tsc` from the package root. The last command compiles source; packaged web builds also copy `src/web/templates/*` into `dist/web/templates/` as the existing build script specifies.
