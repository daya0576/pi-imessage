# 0021. Readable progress without automatic link previews

Status: accepted (owner approved implementation and restart on 2026-10-05)

Supersedes the argument-display details of ADR 0020; routing, admission,
receipts, exclusions and recovery remain unchanged.

**Problem.** `command=[128 chars]` does not explain the work. Clickable URLs
in progress and default answers create unwanted iMessage preview cards.

**Example.** `[tool] bash · 搜索上海天气 · timeout=30` reports intent without
revealing a shell command. `url=weather．com．cn` identifies a source without
a clickable URL.

**Decision.**

- Add an optional short `description` to the native bash schema. Ask the model
  for a non-sensitive purpose in the user's language; delegate execution,
  timeout validation and output handling unchanged to native bash.
- Show the screened, bounded description instead of the command or its length.
  Missing or credential-like descriptions use `执行命令`. Raw commands remain
  private. Descriptions report intent, not verified completion.
- URL arguments show only hostnames with fullwidth dots, never schemes,
  user information, paths, queries or fragments. Screened path/query previews
  omit explicit HTTP(S) URLs.
- Default answers name sources without URLs. Provide original links when the
  user asks. This is prompt policy, not a transport-level preview toggle or
  a prohibition on explicitly requested links.
- Credential screening is best effort; arbitrary secrets in model-authored
  labels cannot be guaranteed detectable.

**Rejected.** Raw shell snippets, another model call to summarize commands,
transport retries, and claiming an unsupported Messages preview-disable option.
