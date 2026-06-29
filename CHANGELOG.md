# y-durablestream

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
