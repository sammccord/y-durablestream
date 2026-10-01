---
"y-durablestream": patch
---

Fix `YStreamClient` stream teardown. `disconnect()` now ends a live `connect()` immediately; it previously waited for the provider's next frame. `syncOnce()` no longer closes a live `connect()` stream that shares its `clientId`. `disconnect()` during an in-flight `subscribe()` now releases the provider-side consumer. `subscribe()` and `unsubscribe()` accept an optional `subscriptionId` to scope teardown to one stream.
