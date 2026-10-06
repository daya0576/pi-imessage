# 0037. Restart during in-flight work

Status: proposed

**Problem.** Routine deployment waits for an idle service. An active chat can keep
the service busy for a long time, so a finished change stays undeployed.

**Example.** A deployment waited while a chat ran a long model request. The owner
restarted anyway: the old process exited in about one second and the new one
resumed the same conversation, which continued its tool calls.

**Decision.**

- Do not wait for idle. Model generations, queued submissions, admitted scheduled
  occurrences and imminent scheduler wakes do not defer a routine restart.
  Durable owns their recovery, and saved deadlines are absolute.
- Stop only at a moment when no tool is running and no message send is in
  progress. Recheck immediately before stopping.
- Stop with SIGTERM only. A shutdown timeout stops the deployment; never force-kill,
  steal the lock or start a second pipeline.
- Accept the recovery costs: an interrupted model request is sent again. A tool
  that started anyway is not replayed; the model sees the interruption. A send
  that started anyway becomes `unknown` and is never resent.
- After startup, verify that interrupted work continues, and that send receipt
  counts are unchanged apart from new sends.

**Consequences.** Deployment no longer depends on chat activity. A restart may
cost one repeated model request and delay a reply by a few seconds. This changes
only the idle requirement in the routine restart procedure (`ops/README.md`);
at-most-once delivery (ADR 0003) and the one-owner rule are unchanged.
