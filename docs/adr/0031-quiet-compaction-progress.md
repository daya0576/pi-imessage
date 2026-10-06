# 0031. Hide only six-hour compaction progress

Status: proposed (owner clarified trigger-specific visibility on 2026-10-06)

Narrows ADR 0020's compaction notices only for six-hour maintenance ticks.

**Problem.** The six-hour timer emits `pi.compaction` progress into chat. The
owner wants that timer quiet, but wants progress for manual `/compact` and
automatic context-threshold/overflow compaction.

**Example.** A timer tick sends neither a start nor completion notice. Manual
`/compact` shows both notices and its command result. A native context-triggered
compaction shows both notices.

**Decision.** Track exact task IDs admitted by `compactChats` using process-local
Harness-scoped state. Before a compaction admission notice, wait for in-flight
timer admissions to resolve so the observer can classify the committed task
before `compact()` has returned its ID. Suppress only a matching timer task's
notice; without an admission notice its settlement also remains quiet. Consume
the classification after observation. Do not mute an entire conversation or
filter by native reason: both the timer and `/compact` use reason `manual`.

Native manual, threshold and overflow task progress keeps its existing routing,
receipts and settlement formatting. Timer execution, logs, six-hour cadence,
manual command results and other progress are unchanged. Classification is not
persisted because pre-start task progress is never replayed.

**Verification.** An existing isolated faux-provider messaging regression with
progress enabled checks timer admission/settlement create no notices or progress
receipts, manual `/compact` shows progress and its result, and native tasks with
threshold/overflow reasons retain both progress receipts. Existing tool and
child-task progress regressions remain enabled.
