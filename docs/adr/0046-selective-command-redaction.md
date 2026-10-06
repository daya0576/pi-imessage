# 0046. Selective command-preview redaction

Status: proposed (owner requested `***` value masking on 2026-10-06; implementation tracked in #36)

Supersedes only ADR 0040's whole-command credential suppression rule.

**Problem.** A mention of `token`, `password`, `.env` or `auth.json` hides the
entire command, even when it is just a source search or filename.

**Example.** `TOKEN=demo123 curl --retry 3` becomes
`→ [tool] bash: TOKEN=*** curl --retry 3`. `rg 'token' src` remains readable.

**Decision.** Replace recognized credential values with `***`, retaining the
surrounding command instead of a hidden-command placeholder. Cover sensitive
assignments, options, authorization headers, URL userinfo, structured values,
known credential prefixes and PEM private-key blocks. Read complete shell words,
including quoted fragments, escaped spaces and command substitutions. Opaque
escaped JSON and ambiguous substitutions may lose additional argument text to
avoid showing a partial credential. Filenames and keyword mentions alone do not
trigger hiding. Screening remains best effort, not an arbitrary-secret guarantee.

Apply masking to the full command before whitespace normalization, URL/domain
defanging and the existing 120-Unicode-code-point bound. Native execution,
non-bash summaries, progress ownership, settlement and durable receipts remain
unchanged. No new scheduler, pipeline, tool execution or delivery replay.

**Verification.** Extend the existing isolated messaging regression with exact
preview examples, quote/escape cases, structured credentials, line continuations,
substitutions, known prefixes, private keys, keyword-only searches and masking
before truncation. Existing native execution, ownership and uncertain-send
regressions remain in force.
