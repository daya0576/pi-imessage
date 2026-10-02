# Compaction lifecycle

## Installed SDK contract (0.85.1)

Verified against `core/agent-session.d.ts` and `.js` in the installed coding-agent:

- `compaction_start`: reason `manual | threshold | overflow`.
- `compaction_end`: same reason, optional `result`, `aborted`, `willRetry`, optional `errorMessage`.
- Manual `compact()` emits those same events. There is no second application-generated start/end pair.
- `prompt()` checks compaction before submitting a pending prompt. Successful preflight continues within that original call even when `willRetry` is false.
- After an assistant response, `_handlePostAgentRun()` awaits compaction. A completed response does not require `agent.continue()` or a new `prompt()` call.
- Overflow recovery retries once through the SDK. The application never reconstructs or submits the old user message. A subsequent exhausted overflow recovery can emit an end-only failure event; that is reported as failed recovery, not another successful compression.
- `abort()` waits for SDK idle, but preflight can subsequently enter the agent loop. A cancelled generation therefore also aborts at `agent_start`, when agent-core already owns its AbortController.

## Routing and clocks

`runPrompt()` owns automatic, preventive, and explicit manual compaction. Notifications
are serialized with final replies, sanitized, and distinguish unfinished original work,
accepted later input, and a completed turn. The transport supplies a live queued-input
view; the session queue and SDK pending-message count are also consulted.

The existing foreground idle limit and foreground duration budget are unchanged.
Compression suspends both clocks and uses a fixed, non-renewing deadline, default
`AGENT_COMPACT_TIMEOUT_MS=600000`. A final assistant stop enters the same maintenance
budget while the SDK settles/authenticates/prepares post-response compaction. Manual
preparation also uses this budget. Only actual SDK start events announce compression.
No heartbeat is synthesized; retry/activity events do not extend the compression deadline.

Preventive compression still runs after the reply, before later input, at the existing
model-relative threshold. It is not repeated if the SDK already attempted compression
in that prompt, including failed attempts.

## Cancellation and failure

- Provider failure/cancellation is not reported as success or passed to the transport's prompt-retry decorator. Uncertain original work is paused, never replayed by this patch.
- A compression deadline requests abort but retains the session and the original SDK operation. Accepted later input waits for both the operation and cancellation to settle. If they never settle, it remains paused in memory; there is no unsafe forced replacement or retry loop.
- `/stop` and `/new` bypass scheduling, not the normal self-echo/reply-enabled admission pipeline. Their SDK settlement wait is bounded to 10 seconds after obtaining ownership; an unconfirmed cancellation returns an honest pause notice. `/new` cannot unlink or replace persistent context while an old operation can still write it.
- A per-storage-key ownership gate covers initialization, prompt admission, and the entire stop/replace/create window. The existing serial input chain lives independently of the replaceable session. Already accepted inputs are not assigned a cancellation epoch; they resolve the current session when admitted. Repeated cancellation reuses settlement rather than clearing future inputs or repeatedly aborting.
- When cancellation actually settles, one terminal Chinese notice is queued before later input proceeds. It never resumes the stopped request. Old-session notices fenced by a successful `/new` are superseded by that command's Chinese new-session confirmation.
- Generation fences cover assistant text, tool starts/ends, and deferred compaction notices/status before delivery. A transport send that has already begun cannot be recalled.
- Read-only background summarizers retain their tool allowlist and bounded background failure handling. Lifecycle notices are not mixed into their collected summary text; unsuccessful compaction without a completed summary propagates a failure. Chat-local thinking settings, Tasks and Sources remain unchanged.

Accepted queued input is preserved for the lifetime of this process, not made newly
crash-durable by this patch. This is not generic interrupted-task continuation. The
existing ordinary foreground timeout path still saves its uncertain-outcome checkpoint and reports timeout, including after successful preflight/overflow compression;
SDK pre-prompt authentication before any compaction event is still foreground work.
Timeout reports use a per-storage-key explicit-cancellation fence, not session identity:
automatic replacement cannot suppress a pending timeout report, while `/stop` and
`/new` invalidate it even after the timed-out session was detached. Other session
output retains the stricter session/epoch fence. The pipeline drains emitted replies
in `finally` before releasing the transport queue, including on prompt rejection.
No claim is made about why a provider stalls.

## Validation

From the package root, without shared test-cache writes:

```sh
npm run check
TMPDIR="$ARTIFACT_DIRECTORY/test-tmp" node_modules/.bin/vitest run --no-cache
node_modules/.bin/tsc --outDir "$ARTIFACT_DIRECTORY/build-output"
mkdir -p "$ARTIFACT_DIRECTORY/build-output/web/templates"
cp src/web/templates/* "$ARTIFACT_DIRECTORY/build-output/web/templates/"
```

Project instructions prohibit `npm test` and `npm run build`; the direct test runner
and equivalent compilation/template-copy steps above were used instead. Compilation
artifacts and full validation logs stay in the supplied iteration directory. Initial failing
validation outputs are retained there as well.

The focused regressions cover compaction/foreground clocks, checkpoint reporting after
preflight (including delayed delivery across replacement, stop, and reset),
continuation without application replay, failed/aborted compression,
repeated cancellation with accepted inputs, asynchronous creation/replacement races,
transport admission, and delivery-time fencing of tool traces as well as assistant text.

`agent-sdk-post-answer.test.ts` drives the production bot consumer, pipeline, and
manager with an actual installed SDK `AgentSession` and agent loop. Its final response
triggers the SDK's post-agent threshold compaction (after `agent_end`), waits three
simulated minutes, then processes an input queued in the transport. The response,
usage, authentication and extension-provided summary/delay are synthetic; no provider
or messaging network is used. This regression specifically covers the original
post-answer path, not merely a direct SDK preflight call.

The opt-in `src/__tests__/fixtures/compaction-provider-probe.ts` separately runs real
Astra high in a fresh private artifact directory, using scratch copies of existing
authentication/configuration through the SDK authentication API. It has no tools,
extensions or memory and a 180-second process deadline. Synthetic history/usage force
SDK preflight compression; summarization and the subsequent prompt are real provider
calls. Prior verification reported one `prompt()` producing ordered
`compaction_start`, successful `compaction_end` (`willRetry=false`), `agent_start`,
and `agent_settled`, with the exact requested synthetic final marker, followed by
removal of scratch authentication and model configuration copies. This is explicitly
prior evidence, not this iteration's validation. It does **not** verify real provider
post-answer timing or production delivery. The timeout-delivery repair changes no
SDK calls; no real-provider probe was rerun for this iteration.

Private per-run evidence and full current validation logs are in the supplied
iteration directory alongside `implementation-result.json`. External review and
guarded deployment remain required; source repair is not deployment completion.
