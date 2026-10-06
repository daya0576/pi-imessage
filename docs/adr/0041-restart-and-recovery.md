# 0041. Restart and recovery

Status: accepted (owner accepted on 2026-10-06; consolidates ADRs 0037–0039 without changing behavior)

**Problem.** Restart rules are spread over three ADRs, each replacing part of
the previous one.

**Example.** A chat is running `bash` when a deployment restarts the service.
The old process exits within seconds, the new one starts, the command runs
again and the turn continues.

**Decision.**

- A routine restart may happen at any time; no task, tool, send or scheduler
  state defers it.
- Stop with SIGTERM only. A shutdown timeout stops the deployment; never
  force-kill, steal the lock or start a second pipeline.
- Durable recovers everything else. An interrupted model request is sent again.
  A tool without an explicit `replay` reruns; a tool whose effect must not
  repeat declares `replay: "unsafe"`.
- Replies and `send_message` stay at most once (ADR 0003): an interrupted send
  becomes `unknown` and is never resent.
- After startup, verify that interrupted work continues and that receipt counts
  change only by new and interrupted sends.

**Consequences.** Deployment never waits for chat activity. A restart can cost
one repeated model request, lose one reply or repeat a partial tool effect;
the owner accepts these as rare. This supersedes ADRs 0037–0039.
