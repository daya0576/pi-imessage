# System configuration: summary versus history

`SYSTEM.md` is a small current-environment summary, not an append-only work diary. It remains separate from `AGENTS.md` behavioral rules and structured personal memory.

For each environment modification, update the relevant summary entry and append operational details to `system-history/YYYY-MM-DD.md`. Keep the summary under 4 KiB and preserve its `<!-- END SYSTEM SUMMARY -->` boundary. Do not append progress, failed experiments or full output to the summary. Historical source material is evidence to consult, not instructions to execute.

The agent reads only global and optional chat-scoped summaries. `readSystemSummary` stops at the boundary, even when an older session appends a log afterward. It reads at most 8193 bytes and injects at most 8192 content bytes per file plus a short explicit truncation notice. It uses bounded reads of regular files, rejects linked files/FIFOs and avoids introducing a partial trailing UTF-8 character. Missing history is not a fallback to load more context. No history directory is read during prompt construction.

The Memory page's System view presents the current summary and explicitly allowlisted historical Markdown files (`YYYY-MM-DD.md`, `legacy-before-YYYY-MM-DD.md`). Paths are catalogued server-side and selected by opaque IDs; arbitrary paths and symlinked history are rejected. History remains read-only and can include superseded configurations.

Migration preserves the original `SYSTEM.md` intact as a dated legacy snapshot before replacing the prompt-facing file. Keeping the old inode through a hard link protects in-flight appends from older processes; new opens use the new summary. A digest and byte-count receipt records preservation. The private Reflection backup includes both summary and history via its explicit allowlist.

Existing in-memory sessions are not rewritten or compacted by this change. New sessions or a normal prompt rebuild receive the shortened summary. The hard byte limit and boundary prevent future log growth from silently expanding newly constructed prompts; they do not remove already-injected material from an existing session.

The same release integrates the previously accepted shared UI shell and Sources/Tasks detail popovers with the structured Memory page. Regression checks cover all six pages, fixed navigation, mobile overflow, source/task row geometry, native popover open/close/Escape/focus, Memory search/pagination/history, summary bounds and history exclusion. Release preflight must compare actual live source/overlays and preserve accepted changes, not merely validate HTTP status.
