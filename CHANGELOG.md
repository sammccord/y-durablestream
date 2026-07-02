# y-durablestream

## 0.9.0

### Minor Changes

- 7f7d3d0: Performance, billing, and leak fixes across the provider, client, and both storage backends.

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

## 0.8.0

### Minor Changes

- a5924e4: Add notify-push live delivery for Durable Object subscribers.

  A DO subscriber's `subscribe()` stream read-loop cannot outlive the request that
  opened it, so the provider's stream-based broadcast never reaches an
  already-connected DO subscriber on a later request. This adds an RPC-based
  delivery path alongside the existing stream transport (fully back-compatible):

  - `YStreamProvider.register(clientId, address)` / `deregister(clientId)` — a
    persisted subscriber registry (survives isolate eviction). `address` is opaque.
  - `YStreamProvider.pushToSubscriber(address, update, key)` — a protected hook
    (no-op by default) invoked for each registered subscriber except the update's
    origin (echo suppression by `clientId`) on every applied update. A subclass
    implements the actual RPC to the subscriber DO (which also wakes it from
    hibernation).
  - `YStreamClient.syncOnce()` — a one-shot bidirectional sync (pull provider
    state + push local state) with no persistent read-loop, safe to call per
    request (shard open / tick / missed-push recovery).
  - `YStreamClientOptions.clientId` — set a stable client id (so `register`,
    `update`/`pushLocalUpdate`, and echo-suppression all agree); defaults to a
    random UUID as before.
  - `YStreamClient.pushLocalUpdate(update, key?)` — forward a local doc update to
    the provider without holding a persistent stream (for subscribers that drive
    their own `doc.on('update')`).

## 0.7.0

### Minor Changes

- 154d2e7: Add interest-routed partial sync.

  `subscribe(clientId, interest?)` scopes a subscriber to a set of routing keys: it then receives only keyless (control) frames and keyed updates whose key is in its interest set, plus an interest-scoped initial sync. Route an update to a key via `update(data, clientId, key?)` / `applyUpdate(update, key?)`, or — on the client — by the originating transaction's `key` together with `YStreamClientOptions.interest`. Override the new protected `YStreamProvider.buildInitialFrames(interest)` to build an interest-scoped snapshot (the base sends the full document); backpressure `resync` rebuilds the snapshot scoped to the consumer's current interest.

  Additive and wire-compatible: a subscriber with no interest set gets full sync exactly as before. New: `YStreamClientOptions.interest`, the `interest`/`key` parameters on the provider RPC surface, and a per-consumer interest filter + `setInterest` in the internal broadcast buffer.

## 0.6.0

### Minor Changes

- 67577fa: Chunked initial sync — stream documents of any size.

  The provider now splits each message — notably the full-document `SyncStep2` sent on connect and on backpressure `resync` — into frames of `frameChunkSize` (default 1 MB) via a new message layer (`encodeMessage` + `createMessageDecoder`), and the client reassembles them. A document larger than a single frame is no longer rejected by the frame cap; syncable document size is now bounded only by Durable Object memory.

  The split is at the **byte** level and concatenates back to the exact original update bytes, so the real Yjs struct identity is preserved (one `applyUpdate`) and ongoing convergence + resync stay correct — unlike repackaging through a temp doc. Reassembly is robust to mid-message drops from a resync fast-forward (a part with `index === 0` starts a fresh message and discards any partial).

  **Breaking (wire protocol):** a 0.6.0 provider and a pre-0.6.0 client (or vice-versa) are incompatible — upgrade both ends together. New `YStreamProviderOptions.frameChunkSize`; new exports `encodeMessage`, `createMessageDecoder`, and the `MessageDecoder` type.

## 0.5.0

### Minor Changes

- 01ec52d: Add a configurable frame-size cap.

  `createFrameDecoder` now accepts `{ maxFrameSize }`, and `YStreamClient` accepts a `maxFrameSize` option, letting trusted Durable-Object-to-Durable-Object deployments sync documents whose full-state `SyncStep2` exceeds the 1 MB default. The full document is streamed as a single frame on connect (and on backpressure resync), so the per-frame cap is the hard ceiling on syncable document size — raising it raises that ceiling.

  The default stays 1 MB: it is a safety guard against a malformed/hostile length header allocating unbounded memory, **not** a yjs or DO-storage limit. New exports: `DEFAULT_MAX_FRAME_SIZE` and the `FrameDecoderOptions` type.

## 0.4.0

### Minor Changes

- 1d19e34: Fix CRDT-correctness, memory, and robustness issues in the broadcast and provider layers.

  **Breaking changes**

  - `BackpressurePolicy` is now `"resync" | "error"` (was `"drop-oldest" | "drop-newest" | "error"`), and the default changed from `"drop-oldest"` to `"resync"`. The old "drop" policies silently discarded incremental Yjs update deltas, which permanently diverged a subscriber (later updates depending on a dropped one stay pending in Yjs forever). `"resync"` instead hands a lagging consumer a fresh full-state snapshot so it converges with no data loss. Update any code passing `backpressure: "drop-oldest"` / `"drop-newest"` to `"resync"`.
  - `YStreamProviderStub.subscribe` and `.update` now accept an optional `clientId` argument. The built-in `YStreamClient` supplies it automatically; custom stub implementations remain compatible because the parameter is optional.

  **Fixes**

  - **Bounded memory under load.** The broadcast buffer is now trimmed on every push, and no backpressure policy retains an unbounded backlog for a stalled consumer (the old `"drop-newest"` was a no-op that leaked).
  - **No self-echo.** A subscriber's own update is no longer streamed back to it (via the new `clientId`), removing redundant per-update traffic.
  - **Durable, non-blocking persistence.** Provider broadcasts updates before persisting, persists via `ctx.waitUntil`, and routes storage failures to a new overridable `onStorageError` hook instead of dropping the broadcast or throwing an unhandled rejection. End-of-life compaction (`onEmpty`) is likewise tied to `waitUntil`.
  - **Reliable disconnect during reconnect.** Fixed a race where `disconnect()` could be ignored if it landed between a reconnect attempt's dispose check and the next connect.
  - **Ordered KV update keys.** Incremental update keys are zero-padded so `list()` returns them in numeric insertion order.
  - **Faster frame decoding.** The frame decoder uses a read offset instead of re-slicing, making multi-frame chunks O(n) instead of O(n²).
  - **Green CI.** `npm run typecheck` now passes over `src` + `test`, and the release workflow runs typecheck, build, and the test suite.

## 0.1.0

### Minor Changes

- 30992fd: Initial release of y-durablestream.

  - **YStreamProvider** — Durable Object that hosts an authoritative Yjs document and streams updates to subscribers via `TransformStream`
  - **YStreamClient** — Synchronises a local `Y.Doc` with an upstream provider using `ReadableStream` for receiving updates and direct RPC for sending changes
  - **DurableObjectKvStorage** — Default storage backend using the Durable Object async KV API with automatic snapshot compaction
  - **DurableObjectSqlStorage** — Alternative storage backend using the Durable Object synchronous SQLite API for lower cost and atomic transactions
  - **YDocStorage** — Pluggable storage interface for implementing custom persistence backends
  - **Protocol utilities** — Length-prefixed message framing (`encodeFrame`, `createFrameDecoder`) for reliable delivery over `TransformStream`
