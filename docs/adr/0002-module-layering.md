# 0002. Modules in strict layers

Status: accepted (2026-10-04; owner accepted 2026-10-05)

**Context.** The old `src/` was flat; `agent.ts` alone was 1,536 lines, and any file could import any other.

**Decision.** Folders sit in rows ([architecture.md](../architecture.md)). A row imports only rows below it. `test/architecture.test.ts` enforces this. Functions over classes; no DI.

**Consequences.** Transport can be tested without an agent. Changing the agent never touches Messages code.

**Rejected.** A flat `src/` (the old layout). One package per layer (too much ceremony for one app).
