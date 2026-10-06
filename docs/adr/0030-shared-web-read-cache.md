# 0030. Share a versioned web read cache

Status: proposed

**Context.** The chat overview requests each conversation separately and repeats
reads on refresh and navigation. Large native payloads include model-only data
that the page never renders. Time-based caching would hide recent changes.

**Decision.** Keep one bounded, process-local cache in `web/`, shared by pages
and read-only APIs. Read through the owning Harness, never its storage files.
Every non-empty Durable commit changes the native cache version. File-backed
views validate inode, size and nanosecond modification/change timestamps on
each access; enumerate memory namespaces on each request to detect additions
and removals. Coalesce concurrent reads and recheck the version after loading;
retry if it changed. Do not retain rejected reads or oversized results.

Limit the cache to 128 entries and a 16 MiB serialized-size budget using
least-recently-used eviction. This budget is not an exact JavaScript heap limit.
Do not cache model health requests or resolved registry-dependent agent choices.

Embed display-only chat data in the initial HTML and batch overview refreshes.
Keep existing native data response shapes. SSE readiness includes a process and
revision marker so the client can detect changes between HTML loading and stream
attachment, without always fetching the initial view twice. Refreshes already
in flight do not discard subsequent change notices.

**Consequences.** Restart discards the cache. There is no second durable state,
execution log, writer or model call. A response reflects versions checked while
it is read; changes during network transit still require a later refresh. File
freshness relies on filesystem metadata, not a fixed stale-data interval.

**Rejected.** Browser-local copies as the shared cache, fixed cache TTLs,
persistent materialized views, and rebuilding all page data on every commit.
