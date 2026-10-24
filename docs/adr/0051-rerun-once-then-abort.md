# 0051. Rerun an interrupted tool once; abort it at the second stop in a row

Status: proposed (owner-requested implementation, 2026-10-24; replaces 0050)

**Problem.** ADR 0050 aborts every tool running at an ordinary stop. The owner
wants the default of ADR 0041 back: most interrupted work should continue by
itself after a restart. Only the loop that 0050 was written for must still end:
a tool call that stops the service reruns on every start and stops it again.

**Example.** A deployment interrupts a `bash` call listing a directory. Under
0041 the command runs again and the turn continues. Under 0050 the model gets
an error result and must call the tool again. A self-restart call, by
contrast, is rerun on every start and never settles.

**Decision.**

- A tool running at an ordinary stop is rerun at the next start, as in 0041.
- The host records the tool tasks running at each stop in a Durable document.
  A tool task that is still running at the next stop, so after it was already
  rerun once, is marked for abort with `abortTask()` before the Harness closes;
  the host waits a few seconds for the marks to settle. The model receives the
  partial output and decides whether to call the tool again.
- Crash recovery, `replay: "unsafe"` and at-most-once sends are unchanged.

**Consequences.** Ordinary deployments keep continuing interrupted work. A
self-restart that waits inside its own tool call costs one extra restart
instead of looping. A long tool interrupted by two deployments in a row is
aborted and the model repeats it. This replaces ADR 0050 and amends the tool
clause of ADR 0041.
