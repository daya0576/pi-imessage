# HTTP API

[Back to README](../README.md)

Default address: `http://localhost:7750` (configured by `WEB_HOST` and `WEB_PORT`).
The server has no authentication; do not expose it to untrusted networks.

The pages `/`, `/chat`, `/tasks`, `/scheduled`, `/settings`, `/memory` and `/logs` are read-only.
The Tasks tab shows real chat and native schedule ownership trees, including
subagent child conversations and terminal tasks. Internal-only conversations such as model-health
are hidden, including when selected by URL; their stored data is not deleted.
`/tasks/data` retains all conversation records for native diagnostics
and lightweight task summaries, reading every native scan page. Input and payloads
are fetched only when a task is expanded, through `/tasks/task/data?taskId=ID`.
`/tasks?conversationId=ID` focuses one conversation and its descendants. The tree
and expanded tasks update only on manual refresh. Conversation lists and sidebars
use newest message activity first, with conversation ID as a descending tie-break;
Tasks uses the same activity clock as Recent Chats, not conversation creation order.
Conversation windows have a maximum height of `min(560px, 70dvh)` and scroll inside. These are latest task states,
not checkpoint history: terminal tasks retain input and outcome, but no checkpoint.
Existing redaction and large-string truncation apply to task details too.
`/chat/data?conversationId=ID` exposes history/live state; `/events` announces
committed changes without executing anything. Native history cursors use
base64url-encoded JSON in `cursor`; long results are paged and large text is
truncated. HTML, JSON, JavaScript and CSS responses of at least 1 KiB support
negotiated gzip compression with `Vary: Accept-Encoding`. SSE stays uncompressed
so notifications are not buffered.

The chat overview embeds at most 15 displayed messages per conversation in its
initial HTML, ordered by message timestamps (including imported dates). Group
names are retained even when their source message is outside that window.
`/chat/data?view=overview` batches the same bounded view for refreshes, without
system prompts, tool results, image payloads or agent configuration.
`/chat/data?conversationId=ID&view=display` returns display-only history, chat
metadata, reply settings and a revision marker without separate index/settings
requests; detail history and its older-page cursors are not reduced to 15
messages. Existing `/chat/data` and conversation detail responses without these
view parameters retain their native state shapes.

Pages share a bounded process-local read cache (proposed ADR 0030). Every native
commit changes its version; file-backed data checks inode, size and modification/
change times on every request, including same-size edits. Concurrent reads share
one load and retry if the version changes while loading. There is no fixed stale
interval, persisted cache or cached model health response. Resolved agent choices
are read directly, since registry changes need not produce a Durable commit.

Pages load once and refresh only through the Refresh button, memory filtering/
pagination or explicit navigation. There is no browser SSE connection, periodic
polling or visibility-triggered refresh. Expanded task payloads are still loaded
on demand. The standalone `/events` API remains compatible for existing clients;
the web pages do not use it. Cache invalidation still makes manual reads current.

Memory pages use server-side filtering and 20-record pagination. The additive
`/memory/data?view=records` view accepts `q`, `namespace`, `kind`, `status` and
`page`; status defaults to `active`, and an empty status selects all records.
Responses include only the selected page plus counts and filter choices.
Supersession is resolved across namespaces before filtering. Complete JSONL
records and long memory text are never character-truncated; invalid source lines
are counted and reported without modifying source files. The original
`/memory/data` raw namespace-array shape remains available with complete content.
Known credential fields/token patterns are redacted, not a guarantee
that arbitrary user-written secrets can be identified.

The agent sends files and extra messages with its immediate `send_message`
tool. HTTP `/prompt` and `/send` remain retired. Legacy cron management,
reminders and PT Automation routes remain removed and return 404 (ADR 0019).

`GET /scheduled` and `GET /scheduled/data` expose configured native background
jobs (ADR 0032), not the retained legacy cron files. The JSON view contains `jobs`
with cadence, enabled state, native scheduler task/conversation IDs, phase and
`nextAt`, and each job's latest ten execution tasks. `recent` contains the latest
ten executions across all jobs. Results separate native task outcome from the
message transport receipt (`sent` is not recipient confirmation). These views
never resume the Harness or invoke a model. POST/DELETE return 404; there are no
run, pause or resend buttons. Scheduling configuration takes effect at startup.
Daily slots and learning dates use the service machine's local timezone (or an
explicit process `TZ`). Each job includes `timezone`; Web deadlines and history
use it even when the browser is in another timezone. Saved absolute deadlines
remain unchanged on restart (ADR 0034).

| Endpoint | Description | Example |
|---|---|---|
| `GET /health/model` | Make a live request to the configured default AI model; returns HTTP 200 when healthy or 503 on failure | `curl localhost:7750/health/model` |

The model health endpoint can incur model usage. It is not a passive startup
probe and never sends its answer to an iMessage chat.

Set `progressMessages: true` in `settings.json` to send one short iMessage notice
for each newly admitted native task/tool in reply-enabled chats, except
`pi.generation`. Child calls go to their parent chat. Notices use native names
without IDs, with bounded argument summaries and screened path/search-query
previews. Raw outputs, commands, prompts and document contents stay local.
Known credential indicators are redacted; arbitrary user-authored secrets cannot
be guaranteed detectable. Missing or false keeps final-only delivery. The setting
is reread for each notice; old tasks and unknown sends are not replayed
([ADR 0020](adr/0020-chat-task-progress.md)).
