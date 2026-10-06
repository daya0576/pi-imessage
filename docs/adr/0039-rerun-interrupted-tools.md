# 0039. Rerun interrupted tools by default

Status: accepted (owner decided on 2026-10-06)

**Problem.** Durable reruns an interrupted tool only when the tool declares
`replay: "safe"`; its default is `unsafe`. Bash, file edits, image reads and
workspace tools therefore fail after a restart, although almost all of them can
simply run again.

**Example.** A restart interrupts `bash` listing a directory. Before, the model
received "interrupted and may have partially run" and had to decide what to do;
now the command runs again and the turn continues.

**Decision.**

- The host treats every tool without an explicit `replay` as `safe`, including
  built-in, Durable and workspace extension tools.
- A tool whose effect must not repeat declares `replay: "unsafe"`.
- Replies and `send_message` keep at-most-once delivery through their own send
  receipts (ADR 0003): a rerun never resends a `sending` or `unknown` message.

**Consequences.** Restarts rarely surface interrupted tools to the model. A
rerun tool may repeat a partial effect, such as appending to a file twice. This
supersedes the interrupted-tool clause of ADR 0038.
