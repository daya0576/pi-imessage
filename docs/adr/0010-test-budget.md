# 0010. About 40 tests, only for our code

Status: proposed (2026-10-04)

**Context.** #31 reached 404 tests. Many retested Durable's own guarantees, or killed subprocesses to probe crash windows.

**Decision.** At most about 40 tests, each for a distinct behavior of our code. Faux provider, temp directories and a fake sender; never real Messages, models or production data. Durable's guarantees (crash resume, tool replay, request dedupe) are not retested. To add a test over budget, delete a weaker one first. Real model and Messages checks live in a manual `ops/smoke.ts`.

**Consequences.** Some bugs will ship; each gets a regression test when found.

**Rejected.** Subprocess crash tests. A unit test per function.
