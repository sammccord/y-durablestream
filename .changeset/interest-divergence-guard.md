---
"y-durablestream": minor
---

`YStreamClient` now reports a `PendingUpdateError` through `onError` when an update from the provider cannot be applied because updates it depends on never arrived. With `interest` set this happens when one writer's Yjs client changes more than one routing key; the `interest` docs now state that constraint.
