---
"y-durablestream": minor
---

`YStreamClient` now reports a failed `subscribe`, a stream error, or an undecodable frame (such as one larger than `maxFrameSize`) through `onError` instead of ending silently. `syncOnce()` resolves `true` on success and `false` on failure.
