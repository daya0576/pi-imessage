# Read-only Memory browser

`GET /memory` replaces the legacy-only page with five server-rendered views:

- Structured memory: effective records by default; text/provenance search, namespace/kind/status filters, bounded pagination and cross-namespace correction history.
- Core: the small always-on `skills/file-memory/core.md`.
- Agent rules: `AGENTS.md` at the running SDK's `getAgentDir()` and at `workingDir`, explicitly labeled by scope. This is a fixed document browser, not a claim to enumerate every SDK context file or prove existing sessions have reloaded. SDK context-file precedence/ancestor discovery is described in an expandable explanation.
- System configuration: compact global and allowlisted direct-chat `SYSTEM.md` summaries plus allowlisted dated files in `system-history/`, clearly distinguished from current state and never auto-injected into the model.
- Archives: global and direct-chat legacy `MEMORY.md`, labeled inactive and read-only.

`GET /memory/data` exposes the same bounded view model. The former `{globalMemory, chatMemories}` JSON shape is replaced, not retained as an active-memory interface. No known internal consumer uses the legacy shape. All non-GET Memory methods are rejected. There are no save, delete, migration, ingestion or arbitrary-file endpoints.

## Semantics and safeguards

The view reads the namespace JSONL through the stable file-memory root, intentionally allowing that root symlink. It never follows symlinks beneath that root or arbitrary source-path references. Document selection uses opaque IDs from a fixed catalog. Neither API parameters nor source labels are interpreted as filesystem paths.

Effective status uses the deployed `activeMemoryItems` function over the entire parsed corpus before namespace filtering; raw `status: active` alone is insufficient. Canonical retrieval and writing code remain unchanged. Full predecessor/successor history is selected before current search/status filtering, retains branches and duplicate-ID rows, and stops at a 200-row bound. IDs remain visible even when a predecessor is missing.

Malformed topology/files, scan limits and duplicate IDs make global effectiveness uncertain. Metadata diagnostics are kept on the affected rows; records are never silently upgraded to active after incomplete parsing. Unknown factual dates remain unknown and separate from recording timestamps. Display order compares timestamp instants, including offsets, with stable ID/file/line tie-breakers.

Readers bound total bytes, individual files/lines, record and directory counts, history and query sizes. Plaintext and stored text are escaped through Eta; external/source paths are not executable links. A restrictive CSP, no-store responses and no-referrer policy apply. Rendering finishes before a successful HTTP status is sent. Error responses omit raw exception strings and file contents.

This page retains the application's existing LAN exposure and does not introduce new authentication or change the bind address. It is for the same trusted local users as the existing chat UI, not a public publishing interface. Do not expose the service publicly without a separate access-control review.

## Validation

Tests use fictional temporary data, covering canonical parity, cross-namespace/transitive/branched corrections, incomplete data, duplicate IDs/cycles/missing predecessors, bounded history, query/path/HTML injection, allowlisted documents, HTTP read-only behavior and failure responses. Browser checks use a disposable fixture-only HTTP handler, never the production worker, and exercise all five views at mobile/desktop widths, search, pagination and history.
