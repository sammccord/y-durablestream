---
"y-durablestream": minor
---

Add interest-routed partial sync.

`subscribe(clientId, interest?)` scopes a subscriber to a set of routing keys: it then receives only keyless (control) frames and keyed updates whose key is in its interest set, plus an interest-scoped initial sync. Route an update to a key via `update(data, clientId, key?)` / `applyUpdate(update, key?)`, or — on the client — by the originating transaction's `key` together with `YStreamClientOptions.interest`. Override the new protected `YStreamProvider.buildInitialFrames(interest)` to build an interest-scoped snapshot (the base sends the full document); backpressure `resync` rebuilds the snapshot scoped to the consumer's current interest.

Additive and wire-compatible: a subscriber with no interest set gets full sync exactly as before. New: `YStreamClientOptions.interest`, the `interest`/`key` parameters on the provider RPC surface, and a per-consumer interest filter + `setInterest` in the internal broadcast buffer.
