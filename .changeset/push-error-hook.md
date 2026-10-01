---
"y-durablestream": minor
---

`pushToSubscriber` may now return a promise. The provider ties it to the Durable Object's lifetime and routes a throw or rejection to a new `onPushError(error, address)` hook, so a failing subscriber can be reported or deregistered. Previously a rejected push was dropped silently, and a synchronous throw went to `onStorageError`.
