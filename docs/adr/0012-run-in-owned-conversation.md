# 0012. `/run` works in a conversation owned by one task

Status: proposed (2026-10-04). Replaces the `/run` part of [0008](0008-compaction-and-run.md); its compaction part stays.

**Context.** In 0008, `/run` works inside the chat's own conversation. Stopping it then means telling run work apart from ordinary work: `Conversation.abort()` also withdraws ordinary queued messages, so the draft tracked submission IDs and command receipts by hand. Durable already scopes abort by ownership: aborting a task aborts the conversations and work it owns.

**Example.** The user sends `/run 30m plan a two-day trip`, then "make it three days". The correction must reach the run. A later `/stop` must end the run without touching anything else.

**Decision.**

- `/run <duration> [task]` creates one Durable task that owns a fork of the chat conversation at its newest entry. The fork inherits the context; nothing is copied or summarized. The task text (default: continue the current task) is the fork's first input. One run per chat.
- `/run` starts only when the chat conversation is idle. Otherwise it replies that the chat is busy and does nothing: no queueing, no moving of running work. A repeated `/run` during a run updates the deadline; a task text in it is sent to the run like an ordinary message.
- While a run is active, all ordinary messages of the chat go to the run conversation as steers, with the message GUID as request ID. Commands do not.
- An `onYield` hook continues the run until the model calls `end_run` (done, or the user is needed) or the deadline passes. The deadline only stops continuation: the current turn finishes, so a run can overrun. Ordinary messages do not extend it. Without unfinished work, the model ends the run instead of inventing a task.
- Final answers of the run conversation are delivered as they are committed, including those between continuations, under [0003](0003-replies-at-most-once.md) and [0011](0011-reconcile-unsent-answers.md).
- `/stop` aborts the run task. Durable aborts the run's work and withdraws its queued messages; they stay in history, unanswered, and are not resubmitted anywhere. Without an active run, `/stop` replies that nothing is running. There is no `/run-stop`. `/new` also stops the run.
- A restart does not stop a run. `resume()` continues the run task like any other pending work, with the deadline from our run document; if it passed during the downtime, the current turn finishes and the run ends. Replies interrupted mid-send follow [0003](0003-replies-at-most-once.md).
- The chat conversation keeps the record: the run's user messages and sent replies are written to it as passive entries, plus how the run ended. Tool calls and results stay in the run conversation, searchable under `durable/` like other history.

**Consequences.** Stopping needs no submission bookkeeping and no command receipts. During a run, the chat has one place where work happens. Messages still queued in the run when `/stop` arrives are dropped, a narrower promise than before. After the run, the chat conversation knows what was said, not how; the model searches the run conversation when it needs details.

**Rejected.** Running in the chat conversation (per-submission abort bookkeeping). A blank run conversation (loses earlier requirements). Queueing `/run` behind ordinary work, or moving running work into the run. Durable's background-subagent example as is (named agents and reporter tasks we don't need). A separate `/run-stop`. Aborting runs at startup (extra code against Durable's resume, and a silent stop the user would wait on).
