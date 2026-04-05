# Development Rules

## Never

- Never over-engineer — no abstractions until needed. Functions > classes. No DI frameworks.

## Always

- When updating code logic, always update the corresponding log statements to reflect the new behavior.
- Always keep modules minimal
- Always keep the web UI minimal: single font (`13px/1.6 monospace`), no per-element font overrides, minimal CSS, ASCII aesthetic — no rounded corners, no shadows, no gradients, no colors beyond opacity

## Knowledge Base

- When working on tasks involving pi-mono internals, message handling, or architecture decisions,
  read `docs/research.md` before proceeding.

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
- NEVER run: `npm run dev`, `npm run build`, `npm test`
- Run tests from the package root, not the repo root.
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- NEVER commit unless user asks

