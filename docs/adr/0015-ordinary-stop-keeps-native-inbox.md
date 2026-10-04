# 0015. Ordinary `/stop` keeps the native inbox

Status: proposed (2026-10-04). Replaces only the no-active-run `/stop` clause of proposed [0012](0012-run-in-owned-conversation.md) if accepted. Does not approve its other behavior changes.

**Problem.** Ordinary `/stop` must cancel current work and foreground children, suppress unclaimed old replies, and preserve later unprocessed ordinary messages. `Conversation.abort()` in Durable 1.0.2 cancels the conversation's foreground scope but withdraws queued inputs. Looking up `LiveDoc.run.taskId` and calling `abortTask()` preserves the parent inbox, but is not equivalent: generation hands over to a new conversation-owned task between turns. The old task can become terminal between lookup and abort; aborting it then does nothing to the new generation.

**Example.** A request reads a file and continues into another model turn. A later ordinary message is queued. `/stop` must cancel the ongoing request, even at that turn boundary, without losing or resubmitting the later message.

**Decision.**

- Preserve this ordinary-chat behavior; do not silently replace it with “nothing is running” or queue withdrawal.
- Require a supported native conversation-scope cancellation operation that atomically selects current foreground work while retaining the root chat's queued inputs. Cancellation of work owned below that scope must still follow Durable's ownership rules. The operation must define admission during cancellation and behavior across generation handover.
- Use the native operation directly. After cancellation settles, suppress old unclaimed drafts using existing delivery records; never change `sending`, `sent` or `unknown` receipts or claim that a started send was undone.
- If preserved inputs require a new boundary, submit one passive cancellation note through the public conversation API. Durable places existing inbox items; the host never copies their content, creates replacement input submissions, or replays the cancelled request.
- Keep `/run` cancellation and isolated API/cron/background/health sessions separately scoped. This decision does not accept dropping queued run messages or cancelling unrelated sessions.

**API boundary.** Durable 1.0.2 exposes no retain-inbox option on `Conversation.abort()`, and its public transaction API has no atomic task-abort operation. An upstream API change and dependency upgrade are required before this design can be implemented as specified. Do not patch installed package files or write the built-in live/inbox documents to simulate that operation.

**Evidence.** The [inbox example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/20-inbox.ts), installed `harness/generation.js` (`createGeneration`, `handOver`), `harness/scheduler.js` (`abort`, `abortConversation`) and public `Tx` declarations establish the distinction. A bounded faux-provider experiment reproduces generation-ID handover and the stale-ID abort no-op; aborting the current generation preserves the queued input, and a passive write places it without a replacement submission. That experiment does not establish a race-free host cancellation implementation.

**Rejected.** Repeated lookup/abort polling, a host cancellation epoch or mirrored inbox, withdrawing and resubmitting queued inputs, direct edits of Durable internals, and treating a cancelled wait as cancelled work. Also rejected: claiming a single generation-task abort cancels a whole multi-turn request.
