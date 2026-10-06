# 0038. Restart at any time

Status: accepted (owner decided on 2026-10-06)

**Problem.** ADR 0037 still waits for a moment with no running tool and no send
in progress. That check adds a step and can still delay a deployment.

**Example.** A chat runs a long bash command. Under ADR 0037 the deployment
waits for it; under this decision the restart proceeds, and the model sees the
interrupted command after recovery.

**Decision.**

- A routine restart may stop the service at any time. No task, tool, send or
  scheduler state defers it.
- Stop with SIGTERM only. A shutdown timeout stops the deployment; never
  force-kill, steal the lock or start a second pipeline.
- Recovery is Durable's: an interrupted model request is sent again, an
  interrupted tool is not replayed, and an interrupted send becomes `unknown`
  and is never resent.

**Consequences.** A restart can lose one reply (left `unknown`) or leave a tool
half-done for the model to check. This supersedes ADR 0037's stop-moment rule;
its verification steps, at-most-once delivery (ADR 0003) and the one-owner rule
remain.
