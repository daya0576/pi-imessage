# 0026. Inline command-only requests

Status: accepted (owner specified `bash: <command>` and a 50-character limit on 2026-10-05)

Supersedes the request-name omission, second-line preview and 100-character
limit in ADR 0025. Preserve shared ProgressEvent data, screening, native
execution, ownership, response formatting and receipt/recovery rules.

**Example.** `→ [tool] bash: printf hi`, then `✓ [tool] bash (0.8s)`.
Other tools retain the screenshot format, e.g. `→ [tool] read: path=/tmp/a.jpg`.

**Decision.** Requests show native name and safe arguments inline. Bash uses
only its screened command preview, not purpose/description text. The preview
is at most 50 Unicode code points including an ellipsis when truncated.
Screen the entire original command before truncation. No actual execution
limit or output handling changes. Response notices remain unchanged.
