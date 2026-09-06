# External data sources

`/sources` is a separate, categorized, read-only inventory beside Tasks. `/sources/data` returns the same metadata as JSON. Tasks represents executions; Sources represents where personal data originates and what evidence exists that ingestion worked. A connector installed or a client logged in is not a successful data sync.

## Scope of this first version

- Fifteen catalog entries across ten categories, including unconfigured future integrations, explicitly labeled as such.
- Every existing web page links to Sources. Each source is one compact row with expandable details, phase, observed state, evidence time, last successful sync and optional processed-record count.
- No new connector, account authorization, browser action, screenshot endpoint, message sending, sync scheduler or model call is introduced by visiting this page. The source inventory is not a replacement for retrieval authorization.
- No credentials, raw connector stderr, message/file bodies, account identifiers, source URLs, screenshot/login tokens or local paths are returned. The current web service is LAN-scoped and has existing access limitations; do not expose it publicly. Sensitive QR images are only sent privately after explicit capture permission and visual inspection, never embedded on this dashboard.

## Registering connectors

Add a source definition to `SOURCE_CATALOG` in `src/sources.ts`, selecting a category and the evidence freshness threshold. New external connectors must register here instead of adding unrelated one-off status pages. Configuration and runtime data stay outside source commits. The inventory does not imply authorization to ingest the listed data.

A source can write an atomic metadata receipt to `<workspace>/sources/status/<source-id>.json` after a verified operation. One connector owns each receipt. Avoid publishing a success when work was merely queued or accepted. Schema:

```json
{
  "version": 1,
  "phase": "scheduled",
  "state": "healthy",
  "reason": null,
  "checkedAt": "2026-01-01T00:00:00Z",
  "lastSuccessAt": "2026-01-01T00:00:00Z",
  "recordCount": 10
}
```

These are fictional example timestamps. Dates must include offsets. Do not set success dates to file mtimes, HTTP acceptance times, page refresh time or client-login time. A successful query alone uses `query_only` and leaves `lastSuccessAt` null because that field tracks ingestion. Source failures preserve genuine prior-success evidence when available; a parse failure never prints the input. Raw errors remain in their protected connector logs.

Phases: `not_configured`, `installed`, `needs_authorization`, `query_only`, `scheduled`.
States: `unknown`, `blocked`, `healthy`, `stale`, `failed`.
Reasons: null or `screen_permission`, `login_required`, `collector_missing`, `sync_unverified`, `no_local_data`, `sync_error`.

Receipts only expose enum values, validated timestamps and integer counts. Additional fields are ignored rather than serialized. Malformed or oversized metadata fails just that source. Healthy status requires the scheduled phase and a valid success no later than the observation timestamp; expired evidence is marked stale. Observed blockage also expires rather than claiming a stale login problem is still current.

## Existing workflow adapters

The page reads these existing metadata formats without modifying their producers:

- Blog updater `skills/blog-memory-updater/state-v2.json`: version 2, processed URL count, last check and failures. Legacy offset-free timestamps explicitly mean Asia/Shanghai. URLs and error strings are not exposed. A prior persisted failure can conservatively remain visible until the updater clears it.
- Optional `sources/reflection-bridge.json` selects the existing bot chat directory containing Reflection checkpoints. It has `version: 1` and `chatDirectory` equal to an existing workspace chat basename, never an arbitrary file path. This local mapping must not be committed because it identifies an account.
- Messages: version 2 committed checkpoint with the Messages row-id lane. This establishes that an incremental Reflection pass committed, not completeness of phone history.
- Immich: version 1 committed image checkpoint; seen-asset count is processed imagery, not total library/video coverage.
- Mail is deliberately not inferred healthy from the common Reflection timestamp. It needs an independent receipt proving messages were available and processed.
- Other installed skill definitions establish only that tools exist; status remains unverified until source-specific evidence is bridged.

Opening the page performs bounded local reads only. HTTP mutations return 405. There is intentionally no arbitrary command/path configuration over HTTP, no fake sync/pause button and no automatic retry triggered by rendering.

## Validation and rollout

Tests cover missing sources, phase/sync separation, freshness, future dates, malformed/secret-containing metadata, blog timezones, independent source lanes, directory traversal rejection, escaped rendering, tab links and read-only HTTP behavior. Verify mobile and desktop overflow using a disposable browser profile. Run the existing application checks and tests before a fail-safe, drained blue-green rollout; do not edit immutable live releases.
