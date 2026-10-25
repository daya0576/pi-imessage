# 0053. Service-log errors for failures that break normal operation

Status: proposed

**Problem.** Durable records every task outcome, but only in its storage.
`service.log` shows startup, sends and a few delivery warnings. On 2026-10-25
the nightly memory reflection failed three times because the model child had
exhausted a provider quota; the process, the port and the root HTTP check
looked healthy and `service.log` had no line about it. The failure was only
visible by reading `durable/main.jsonl` or by a chat notice that was deduped.

**Example.**

```text
2026-10-25T00:14:48.924Z Model call failed {
  kind: 'pi.generation', task: 183434, conversation: 183426, status: 'failed',
  provider: 'openai-codex', model: 'gpt-6.1-sol',
  reason: 'You have hit your ChatGPT usage limit (plus plan). Try again in ~291 min.'
}
```

**Decision.**

- `service.log` gets a `console.error` line with an ISO timestamp for a failure
  that breaks normal operation. A failure qualifies when either holds: a chat
  or scheduled job does not get the result it was waiting for, or the system
  enters a state that needs an operator. Transient errors that recover on
  their own, such as a retried provider error or a delivery whose status is
  later confirmed, do not qualify.
- One module, `src/agent/error-log.ts`, owns these lines. It observes Durable
  commits synchronously and never calls Session APIs. Each error kind is one
  branch with its own message name; adding a kind states which of the two
  conditions it meets.
- The first kind is a model call that ends `failed` or `faulted`: the line
  carries the task, conversation, provider, model and the reason truncated to
  200 characters. It carries no prompt, tool argument or input content.
- Other task kinds, including scheduled jobs that fault, are not logged yet;
  they are added under the same conditions when needed.

**Consequences.** A quota, auth or provider outage is visible in the service
log within the same commit that records it, so a health check that reads the
log catches it without a paid model probe. The web `/logs` page shows the same
lines. Durable records remain the full source of truth; the log is a pointer
to them, not a replacement.
