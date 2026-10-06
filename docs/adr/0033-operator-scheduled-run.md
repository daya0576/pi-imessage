# 0033. Explicit operator run at startup

Status: proposed (owner requested one real Workplace English trial)

**Problem.** A configured job cannot be exercised on demand through the read-only
Web UI. Opening another Harness on the live workspace is unsafe.

**Decision.** An authorized owning-service restart may pass
`serve --run-scheduled JOB --request-id ID`. The existing owner admits one native
background occurrence in the configured job's conversation, after installing its
extension. It saves the request ID and task ID atomically; repeating that startup
request returns the same task. Refuse missing/disabled jobs or another live
occurrence. Do not alter the recurring task or its saved deadline.

Normal startup without the flags remains unchanged. The local startup request
is not stored in settings or installed into launchd. There is no new HTTP route,
Web action button, alternate writer, polling worker or operating-system job.
English still enforces the existing per-date card dedupe and learning policy;
this is not permission to bypass a quota or replay an uncertain send.

**Consequences.** This small operator entry requires a safe restart to trigger.
It is deliberately not a general interactive scheduler-management API. A live
trial can invoke the configured model and send its card, requiring owner consent.
