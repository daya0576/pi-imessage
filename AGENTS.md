# Development Rules

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

## Commands

- After code changes (not documentation changes): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
- Note: `npm run check` does not run tests.
- NEVER run: `npm run dev`, `npm run build`, `npm test`
- Run tests from the package root, not the repo root.
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- NEVER commit unless user asks
