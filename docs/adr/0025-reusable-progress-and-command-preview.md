# 0025. Reusable progress data and short command previews

Status: accepted (owner approved option 5, then clarified request/response names and app reuse on 2026-10-05)

Supersedes the command-opaque/request-name display rules of ADR 0021 and the
request display examples of ADR 0024. Native lifecycle, routing, receipt IDs,
uncertain-effect handling and response formatting are unchanged.

**Problem.** The owner wants readable request purposes, a useful short bash
preview, no tool names in any request, and reusable rules for a future app.

**Example.**

```text
→ [tool] Check the weather
node search.mjs "Shanghai weather" --count 5
✓ [tool] bash (0.8s)
```

**Decision.**

- Requests keep the leading arrow and bracketed type/parent label. Tool names
  do not appear as separate request labels or parenthetical suffixes. Responses
  keep the deployed format: marker, type/parent label, native name and elapsed
  time. This latest clarification replaces the earlier proposed hidden-bash
  response and option-5 parenthetical response examples.
- Bash requests add a second line with at most 100 Unicode code points,
  including a trailing ellipsis when truncated. Screen the whole command
  before truncation. Recognized credential indicators suppress the entire
  preview; explicit URLs and common bare domains are defanged. Native
  execution and timeout enforcement remain unchanged.
- Screening is conservative and best effort, not a guarantee against arbitrary
  unknown secrets. Do not restore raw tool outputs or document-content notices.
- `src/agent/progress-format.ts` defines a transport-independent structured
  ProgressEvent and pure summarization, screening and text formatting functions.
  The native observer creates safe request/response events; iMessage is the
  current plain-text adapter. Future apps can render event fields and reuse
  the safety functions without parsing iMessage text or copying its lifecycle.
- The event retains the native name internally, allowing app rendering and
  response formatting, even though request text omits it. Raw command strings
  do not belong in exported progress events; only screened previews do.
- No app transport, new scheduler, listener, database or delivery replay is
  introduced in this change. A future app connection must wire its own
  delivery/receipt policy explicitly.

**Verification.** Isolated regressions cover the request/response event format,
all-request name omission, native command execution/failure, preview length and
Unicode, screening before truncation, credential suppression, URL defanging,
child attribution, unknown receipts and no restart replay.
