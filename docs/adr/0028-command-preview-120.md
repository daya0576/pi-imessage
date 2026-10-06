# 0028. Use 120 characters for command previews

Status: accepted (owner selected120 after viewing80/120/150/180 examples on 2026-10-05)

Supersedes only ADR 0027's80-character default. Show at most120 Unicode code
points in the command portion, including a trailing ellipsis when truncated.
Retain the inline command-only request, existing response, whole-command
screening before truncation and transport-independent event/formatter.
