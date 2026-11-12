---
"y-durablestream": minor
---

Fix a subscriber stream stall, storage data-loss cases, and silent client failures.

- **Stream stall**: a subscriber stopped receiving updates after its second own write (or, with an interest set, after the second update outside it). The stream now keeps delivering.
- **`gc: false` history**: persistence no longer garbage-collects deleted content on reload or compaction.
- **Large documents**: snapshots larger than one storage value (2 MB on SQLite-backed Durable Objects, 128 KiB on KV-backed) are split across values instead of failing every write. Single updates above the limit persist too. Snapshots that fit in one value keep the previous layout; a larger one cannot be read by earlier versions.
- **Interest scoping**: the client no longer sends its own SyncStep1 on connect. That reply returned the whole document, bypassing the interest filter and transferring a fresh client's state twice.
- **Diff sync**: `subscribe()` accepts the subscriber's state vector as an optional fourth argument and `YStreamClient` sends it, so connect and `syncOnce()` transfer only what the client lacks. `buildInitialFrames` receives it as a second argument.
- **Errors**: undecodable frames/messages and failed `subscribe()` calls reach `onError` instead of vanishing. `syncOnce()` resolves to `true`/`false`.
- **Status**: `status` no longer reports `"disconnected"` between reconnect attempts, only once `connect()` is over.
- Reconnect backoff is jittered, an empty SyncStep2 reply is no longer sent, and KV compaction deletes keys in batches of 128.
- **`yjs` is now a peer dependency**, so the package uses your application's copy instead of possibly installing a second one (duplicate Yjs copies break sync). Install `yjs` alongside it if your package manager does not add peers automatically.

Performance:

- **Compaction** snapshots the provider's live document instead of reading the stored snapshot and updates back and replaying them. `YDocStorage.storeUpdate` takes the live document as an optional second argument.
- **Compaction threshold** scales with the document: updates compact once their bytes exceed `max(maxBytes, snapshot size × snapshotGrowthRatio)` (new storage option, default `0.25`, `0` restores the fixed threshold).
- **Startup** applies persisted state straight to the provider's document through the new optional `YDocStorage.loadInto`, rather than building and re-encoding a second document.
- **KV storage** keeps its compaction counters in memory: two puts and no read per stored update.
- **Backpressure** also triggers on bytes buffered per subscriber (new `streamHighWaterBytes` provider option, default 16 MB), bounding memory when frames are large.
