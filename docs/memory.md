# Structured Memory

[Back to README](../README.md)

Durable memories are stored as namespaced JSONL records under
`WORKING_DIR/skills/file-memory/namespaces/`. Each record includes a stable ID,
creation timestamp, factual event date when known, source, kind, subjects,
importance, confidence, and status. This keeps every memory traceable without
inventing dates for older facts.

The agent uses typed tools to load complete namespaces, search for specific
records, and append validated memories. Corrections append a new record that
supersedes the old ID, preserving an auditable history instead of silently
rewriting it. Legacy global and per-chat `MEMORY.md` files remain read-only
archives.

The service calls the store's existing `memory_cli.py` in that directory using
Python 3 and argument arrays, not a shell or an embedded backend. The CLI is a
runtime prerequisite; missing or failed calls return tool errors. Tool
cancellation terminates the subprocess, but an already completed write is not
undone. Saves are replay-safe because the store assigns deterministic IDs and
skips identical records; corrections pass the existing `supersedes` option.

Core memory (`core.md`) and the namespace list are loaded at startup and refreshed
by `/reload`. `load_memory` and `search_memory` always read the current store.
Explicit extension selection can replace the service's default memory tools for
isolated callers or restricted execution.
