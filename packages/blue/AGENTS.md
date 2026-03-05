# Development Rules

## Knowledge Base

- When working on tasks involving pi-mono internals, message handling, or architecture decisions,
read `docs/pi-mono.md` before proceeding.

## Never

- Never over-engineer — no abstractions until needed. Functions > classes. No DI frameworks.

## Always

- Always keep modules minimal
- Always keep the web UI minimal: single font (`13px/1.6 monospace`), no per-element font overrides, minimal CSS, ASCII aesthetic — no rounded corners, no shadows, no gradients, no colors beyond opacity
