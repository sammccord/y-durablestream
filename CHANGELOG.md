# y-durablestream

## 0.1.0

### Minor Changes

- 30992fd: Initial release of y-durablestream.

  - **YStreamProvider** — Durable Object that hosts an authoritative Yjs document and streams updates to subscribers via `TransformStream`
  - **YStreamClient** — Synchronises a local `Y.Doc` with an upstream provider using `ReadableStream` for receiving updates and direct RPC for sending changes
  - **DurableObjectKvStorage** — Default storage backend using the Durable Object async KV API with automatic snapshot compaction
  - **DurableObjectSqlStorage** — Alternative storage backend using the Durable Object synchronous SQLite API for lower cost and atomic transactions
  - **YDocStorage** — Pluggable storage interface for implementing custom persistence backends
  - **Protocol utilities** — Length-prefixed message framing (`encodeFrame`, `createFrameDecoder`) for reliable delivery over `TransformStream`
