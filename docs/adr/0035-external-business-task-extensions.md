# 0035. Keep business tasks in workspace-owned Durable extensions

Status: proposed (owner requested migrating English out of the framework)

**Problem.** English learning rules, prompts, quotas and a personal job ID are
embedded in the agent, scheduler, settings and Web view. A reusable messaging
application should not know a user's learning policy.

**Example.** Replacing daily English with another personal task should change a
workspace extension, not the framework's source or scheduler branches.

**Decision.**

- Move the English task implementation to
  `WORKING_DIR/extensions/work-english/`. It is a Pi Durable task extension,
  not a Pi coding-agent ExtensionAPI module. A skill may document manual use;
  it must not become a second scheduler or execution pipeline.
- Add one explicit, owner-configured loading and task-registration boundary for
  trusted workspace extensions. Do not execute arbitrary skills or automatically
  discover code from chat attachments. Use public APIs and keep extension loading
  out of message admission. Missing configured task code must block safe startup
  rather than silently discard pending work.
- Keep generic cadence calculation, task ownership, recovery, delivery receipts
  and read-only execution history in the framework. Built-in six-hour compaction
  remains a framework maintenance task. Business prompts, learning documents,
  quotas, legacy learning import and personal configuration belong to the English
  extension. Framework settings, prompts and Web rendering must have no English
  branches or personal job IDs.
- Preserve existing settings data. The workspace extension handles its old English
  configuration; the framework does not retain a special English adapter.
- Retain saved task IDs, checkpoints, deadlines, learning documents, card records
  and request/send IDs during the migration. Keep compatible definitions available
  for existing native records. Do not recreate the job, regenerate an existing card,
  resend uncertain effects or open a second writer.
- Rehearse loading, recovery and migration with a domain-neutral fixture, faux
  models and temporary storage. Production migration is an authorized operation,
  never a test. Install and verify the workspace extension before the single-owner
  restart, preserving rollback copies of its source and configuration.

This proposal supersedes ADR 0032's embedding of English business logic in the
application, not its Durable ownership or at-most-once delivery requirements.
ADR 0034's machine-local calendar rules remain in effect.

**Consequences.** Workspace task code is trusted executable operator configuration
and needs backup alongside its settings. This introduces an explicit extension
contract; it does not promise compatibility with Pi coding-agent extensions or
add LLM scheduling tools, legacy cron adapters or independent workers.

**Rejected.** Only moving `english.ts` while leaving framework dependencies,
putting recovery-sensitive work in a Markdown skill, maintaining two schedulers,
and deleting production learning or receipt data to simplify migration.
