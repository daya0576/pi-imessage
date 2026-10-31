# 0010. The framework integrates iMessage and Durable; the workspace owns behavior

Status: accepted (2026-10-31, owner, grilling session)

**Problem.** Personal behavior, preferences and operations crept into the
framework: a hard-coded idle reset, chat etiquette in the product prompt,
claw-specific Git, deployment and restart procedures in the repository.

**Decision.**

- The *framework* is this repository and the service it runs. The *workspace*
  is `WORKING_DIR` (`settings.json`, `AGENTS.md`, `extensions/`, `skills/`).
- The framework does only the integration of iMessage and Durable: transport,
  chat-to-conversation mapping, delivery and receipts, scheduling machinery,
  the extension loader and read-only views. It keeps general tools (web,
  browser, subagent, memory, images, messages).
- Every other behavior lives in the workspace: personal tasks, chat etiquette,
  thresholds such as idle reset, and operations (Git flow, deployment, restart).
  The framework keeps no default or example for it.
- The product prompt states only facts of the integration (interim and delivery
  semantics, different senders are different people). How to behave belongs in
  workspace `AGENTS.md`.
- Workspace code is a plain Durable extension built with the framework's pinned
  Durable SDK; the framework adds no API of its own for it.

**Consequences.** Another deployment gets the integration and nothing personal.
Changing behavior is a workspace edit and `/reload`, not a release.
