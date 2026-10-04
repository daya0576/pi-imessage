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
