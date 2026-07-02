---
"y-durablestream": minor
---

Performance, billing, and leak fixes across the provider, client, and both storage backends.

**Consumer leak fix (new `unsubscribe` RPC).** Workerd does not propagate `ReadableStream.cancel()` across the RPC boundary, so every ended subscriber stream (including each `syncOnce()`) left its consumer registered on the provider until DO eviction — suppressing last-consumer compaction and re-triggering resync snapshot builds forever. `YStreamProvider.unsubscribe(clientId)` now drops a client's consumers explicitly and `YStreamClient` calls it automatically after every stream teardown and `syncOnce()`. A stale-consumer TTL (`staleConsumerTtlMs`, default 30 s) additionally reaps consumers that die without any cleanup call.

**Billing reducers.**

- Last-consumer compaction (`onEmpty` → `commit`) is now gated by a dirty flag: read-only subscribe/close cycles (every `syncOnce()` poll) no longer pay a full-document encode + snapshot write.
- SQL backend: compaction thresholds use in-memory running counters instead of a `SELECT COUNT(*), SUM(byte_length)` full-table aggregate per stored update; `yjs_updates` drops `AUTOINCREMENT` (one less bookkeeping row write per insert).
- KV backend: the split `ydoc:state:bytes`/`ydoc:state:count` keys merge into one `ydoc:state:meta` key — 3 billable ops per stored update instead of 5. Existing data is migrated on first write.
- Push-subscriber registry is stored one key per subscriber (`__yds:sub:<clientId>`) instead of rewriting the whole map on every register/deregister. Existing registries migrate on first load.
- New `YStreamProviderOptions.notifyDebounceMs`: coalesce notify-push delivery, merging updates applied within the window via `Y.mergeUpdates` into one `pushToSubscriber` call per subscriber per window (default `0` = unchanged immediate delivery).

**Client correctness.**

- Fire-and-forget sends to the provider (`doc.on('update')` forwarding, SyncStep replies, the initial SyncStep1) now route failures to a new `YStreamClientOptions.onError` hook instead of becoming unhandled promise rejections.
- `disconnect()` during a reconnect backoff wakes the sleep (and clears its timer) so `connect()` resolves immediately instead of after up to `maxDelay`.

**Hot-path trims.** Single-part messages skip a redundant concat copy on the client decode path; a backpressure pass builds the full-sync resync snapshot at most once per pass instead of once per lagging consumer; unused WebSocket/streams declarations pruned from the build-time shims.
