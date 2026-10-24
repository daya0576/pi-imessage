# 0050. Abort running tools on an ordinary stop

Status: accepted (owner decided on 2026-10-24 in #39; amends the tool clause of 0041)

**Problem.** ADR 0041 reruns a tool that a restart interrupted. A tool call
that stops the service itself is therefore rerun on every start: the call stops
the new process before it can finish, and nothing ends the loop. Durable's
`restartLimit` does not count an ordinary close, so the task is never parked.

**Example.** On 2026-10-24 a chat deployed a release from one `bash` call that
launched the restart controller and then waited to verify it. The controller
stopped the service while the call was running. Each new process reran the
call, launched another controller and was stopped a second after it started,
about seventy times in eleven minutes, until an operator made the command fail
by hand.

**Decision.**

- Before the host closes the Harness on SIGTERM, it marks every running
  `pi.tool` task for abort with `abortTask()` and waits a few seconds for the
  marks to settle. The mark is durable: a task the close still interrupts is
  aborted at the next start instead of rerun.
- The model receives the tool's error result with the output committed so far
  and decides whether to call the tool again. The turn continues.
- Crash recovery is unchanged: a tool that a crash interrupted still follows
  ADR 0041, and `replay: "unsafe"` keeps its meaning.
- Sends stay at most once (ADR 0003).

**Consequences.** An ordinary stop costs the interrupted tool call one model
round instead of a silent rerun. Partial effects of the stopped command are not
undone; the model sees that the call was aborted and verifies before repeating
it. A self-restart cannot loop. Operators need not reason about a tool's
`replay` policy when stopping the service.
