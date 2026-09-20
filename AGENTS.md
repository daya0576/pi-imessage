# Development Rules

## Default workflow

- A requested code change includes the necessary commit, safe deployment and live verification by default. Do not ask again for deployment permission. Stop only for a material new risk, missing input, scope expansion or an uncertain prior write.
- For a small copy/display/notification change: inspect the directly affected code and tests, make the smallest patch, validate, commit, deploy and briefly report the actual result. Do not reread unrelated history or repeatedly re-plan the same decision.
- Work in an isolated worktree. Before publishing, reconcile with the actual live source and accepted UI; preserve unrelated work. Never edit releases/current as source.
- Deploy only from the clean repository using ops/deploy-detached.sh after committing the verified change. Preserve blue-green validation, idle drain, rollback and post-switch checks. Never restart the running service from inside the agent.
- Register durable completion reporting before detached deployment. Keep internal timeout/retry diagnostics out of chat; report results or actionable blockers without claiming an unverified deployment succeeded.

## Never

- Never over-engineer — no abstractions until needed. Functions > classes. No DI frameworks.

## Always

- When updating code logic, always update the corresponding log statements to reflect the new behavior.
- Always keep modules minimal
- Always keep the web UI minimal: single font (`13px/1.6 monospace`), no per-element font overrides, minimal CSS, ASCII aesthetic — no rounded corners, no shadows, no gradients, no colors beyond opacity

## Knowledge Base

- When working on tasks involving pi-mono internals, message handling, or architecture decisions,
  consult the relevant section of `docs/research.md` before changing those mechanisms. A copy/display-only edit does not require a general architecture review.

## Code Quality

- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- **No meaningless abbreviations for variable names** (e.g., `bb`, `cs`, `sm`, `cb`). Use descriptive names that convey intent (e.g., `blueBubblesClient`, `chatSession`, `sessionManager`).
- **When writing tests, keep cases minimal**: only test distinct behaviours; delete duplicate, symmetric, or "nothing happened" cases. Prefer fewer focused assertions over exhaustive coverage of trivial paths.

## Commands

- After code changes (not documentation changes): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
- Note: `npm run check` does not run tests.
- Run `npm test` for validation. Do not start `npm run dev` on the live host; production builds and restarts belong to the guarded deployment script.
- Run tests from the package root, not the repo root.
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- Commit the validated requested change as part of the default delivery workflow; never include unrelated changes or private runtime data.

