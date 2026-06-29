---
"y-durablestream": minor
---

Add a configurable frame-size cap.

`createFrameDecoder` now accepts `{ maxFrameSize }`, and `YStreamClient` accepts a `maxFrameSize` option, letting trusted Durable-Object-to-Durable-Object deployments sync documents whose full-state `SyncStep2` exceeds the 1 MB default. The full document is streamed as a single frame on connect (and on backpressure resync), so the per-frame cap is the hard ceiling on syncable document size — raising it raises that ceiling.

The default stays 1 MB: it is a safety guard against a malformed/hostile length header allocating unbounded memory, **not** a yjs or DO-storage limit. New exports: `DEFAULT_MAX_FRAME_SIZE` and the `FrameDecoderOptions` type.
