---
"y-durablestream": minor
---

Add notify-push live delivery for Durable Object subscribers.

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
