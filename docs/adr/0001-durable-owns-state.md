# 0001. Pi Durable owns all chat state

Status: accepted (2026-10-04; owner accepted 2026-10-05)

**Context.** The old bot wrapped the Pi SDK in its own queue, retries, timeouts and recovery fences. The first Durable attempt (#31) then added controllers, epochs, outboxes and a supervisor around Durable, and reached 54 files and 404 tests without shipping.

**Decision.** Pi Durable owns all chat state: inbox, deduplication, steering, runs, tool replay and compaction. Our code adds only what Durable cannot see: reading `chat.db` and sending through Messages.app. Use Durable as documented; don't re-check what it already guarantees.

**Consequences.** The host stays small. Durable's limits become ours: one writer per storage, no power-loss guarantee. When its API changes, we update our code instead of adding shims.

**Rejected.** Host-side controller, epoch and outbox layers (the `issue-31-durable` branch).
