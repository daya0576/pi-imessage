# 0027. Modest command preview width

Status: accepted (owner delegated a slightly longer preview on 2026-10-05)

Supersedes only ADR 0026's fixed 50-character width. The current default is
80 Unicode code points, including a trailing ellipsis when truncated. This
balances useful context with phone readability. Keep the same inline
`→ [tool] bash: <screened command>` format and unchanged response notices.
Whole-command screening still occurs before truncation; no purpose text,
raw output, tool execution or channel architecture changes.
