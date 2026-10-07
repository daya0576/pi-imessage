# 0048. Quiet attachment reads

Status: proposed (owner-requested behavior in #38, 2026-10-07)

**Problem.** Reading an archived attachment adds noisy tool notices containing long private archive paths.

**Example.** A native `read` of `WORKING_DIR/attachments/<chat>/<file>` produces no request or completion notice. An ordinary file read still shows the existing progress pair.

**Decision.** Add a narrow exception to ADR 0040's all-tool progress rule: suppress both admission and settlement notices for native `read` calls under the active workspace attachment root, including owned child calls and failed reads. Normalize relative, home, @ and file-URL paths and resolve filesystem aliases using metadata only. Match directory boundaries, not a generic attachment substring. Other reads, tools, task progress, manual compaction and final replies remain unchanged.

The existing native observer filters before assigning notice routing or making direct-send receipts. Execution, result/error history, receipt/no-replay rules and the single pipeline are unchanged. No new poller, sender, permission boundary, data removal or credential policy is introduced.
