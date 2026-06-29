---
"y-durablestream": minor
---

Chunked initial sync — stream documents of any size.

The provider now splits each message — notably the full-document `SyncStep2` sent on connect and on backpressure `resync` — into frames of `frameChunkSize` (default 1 MB) via a new message layer (`encodeMessage` + `createMessageDecoder`), and the client reassembles them. A document larger than a single frame is no longer rejected by the frame cap; syncable document size is now bounded only by Durable Object memory.

The split is at the **byte** level and concatenates back to the exact original update bytes, so the real Yjs struct identity is preserved (one `applyUpdate`) and ongoing convergence + resync stay correct — unlike repackaging through a temp doc. Reassembly is robust to mid-message drops from a resync fast-forward (a part with `index === 0` starts a fresh message and discards any partial).

**Breaking (wire protocol):** a 0.6.0 provider and a pre-0.6.0 client (or vice-versa) are incompatible — upgrade both ends together. New `YStreamProviderOptions.frameChunkSize`; new exports `encodeMessage`, `createMessageDecoder`, and the `MessageDecoder` type.
