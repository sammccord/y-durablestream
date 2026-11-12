# y-durablestream

[![npm version](https://img.shields.io/npm/v/y-durablestream.svg)](https://www.npmjs.com/package/y-durablestream)
[![CI](https://github.com/sammccord/y-durablestream/actions/workflows/ci.yml/badge.svg)](https://github.com/sammccord/y-durablestream/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Yjs document synchronization between Cloudflare Durable Objects via `ReadableStream`.

## Overview

`y-durablestream` enables Durable Object-to-Durable Object Yjs document synchronization over RPC-returned streams. An upstream **provider** Durable Object hosts the authoritative document and streams updates to any number of downstream **subscriber** Durable Objects over `ReadableStream`. Subscribers push local changes back via direct RPC.

```
┌──────────────────────┐                                ┌──────────────────────┐
│  Subscriber DO       │    RPC: subscribe()            │  Provider DO         │
│  (YStreamClient)     │ ──────────────────────────▶    │  (YStreamProvider)   │
│                      │   ◀── ReadableStream<Uint8Array>│                      │
│  local Y.Doc         │        (sync + updates)        │  authoritative Y.Doc │
│                      │                                │  pluggable storage   │
│                      │    RPC: update(Uint8Array)     │                      │
│                      │ ──────────────────────────▶    │  broadcasts to all   │
└──────────────────────┘        (local changes)         └──────────────────────┘
```

### Features

- **Stream-based sync** — provider streams Yjs protocol messages to subscribers via `ReadableStream`, subscribers send changes back via RPC
- **Full Yjs sync protocol** — SyncStep1/SyncStep2 handshake on connect, incremental updates after
- **Pluggable storage** — swap persistence backends by implementing the `YDocStorage` interface
- **Two built-in backends** — async KV API (default) and synchronous SQLite API (cheaper, atomic)
- **Length-prefixed framing** — reliable message delivery over arbitrarily chunked streams
- **No WebSockets required** — pure DO-to-DO communication, no browser in the loop

## Installation

```bash
npm install y-durablestream
```

`yjs`, `y-protocols`, and `lib0` are included as dependencies and do not need to be installed separately.

## Quick Start

### 1. Define the provider Durable Object

```typescript
// src/provider.ts
import { YStreamProvider } from "y-durablestream";

export class DocProvider extends YStreamProvider<Env> {}
```

### 2. Define a subscriber Durable Object

```typescript
// src/subscriber.ts
import { DurableObject } from "cloudflare:workers";
import { Doc } from "yjs";
import { YStreamClient } from "y-durablestream";

export class Subscriber extends DurableObject<Env> {
  private doc = new Doc();
  private client: YStreamClient | null = null;

  async connectToDoc(docName: string): Promise<void> {
    const stub = this.env.DOC_PROVIDER.get(
      this.env.DOC_PROVIDER.idFromName(docName),
    );
    this.client = new YStreamClient(this.doc, { stub });
    this.ctx.waitUntil(this.client.connect());
  }

  async getText(field: string): Promise<string> {
    return this.doc.getText(field).toString();
  }

  async disconnect(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
  }
}
```

### 3. Configure wrangler

```toml
# wrangler.toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "DOC_PROVIDER"
class_name = "DocProvider"

[[durable_objects.bindings]]
name = "SUBSCRIBER"
class_name = "Subscriber"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DocProvider"]
new_classes = ["Subscriber"]
```

> **Note:** The provider class must be declared in `new_sqlite_classes` (not `new_classes`) to enable the Durable Object storage APIs used by both built-in storage backends.

## API Reference

### `YStreamProvider<E>`

A Durable Object base class that hosts an authoritative Yjs document and streams updates to subscribers.

```typescript
import { YStreamProvider } from "y-durablestream";

export class DocProvider extends YStreamProvider<Env> {}
```

#### RPC Methods

| Method | Signature | Description |
|---|---|---|
| `subscribe()` | `() => Promise<ReadableStream<Uint8Array>>` | Subscribe to document updates. Returns a stream of length-framed Yjs sync messages. |
| `update(data)` | `(data: Uint8Array) => Promise<void>` | Receive a Yjs sync protocol message from a subscriber. |
| `applyUpdate(update)` | `(update: Uint8Array) => Promise<void>` | Apply a raw Yjs update directly (for server-side mutations). |
| `getYDoc()` | `() => Promise<Uint8Array>` | Return the full document state as `Y.encodeStateAsUpdate()`. |

#### Protected Properties

| Property | Type | Default | Description |
|---|---|---|---|
| `doc` | `Doc` | `new Doc({ gc: true })` | The authoritative Yjs document. |
| `storage` | `YDocStorage` | `DurableObjectKvStorage` | The pluggable storage backend. |
| `maxBytes` | `number` | `10240` | Max incremental update bytes before compaction. |
| `maxUpdates` | `number` | `500` | Max incremental update count before compaction. |

#### `createStorage()`

Override this factory method in a subclass to use a different storage backend:

```typescript
import { YStreamProvider, DurableObjectSqlStorage } from "y-durablestream";
import type { YDocStorage } from "y-durablestream";

export class SqlDocProvider extends YStreamProvider<Env> {
  protected override createStorage(): YDocStorage {
    return new DurableObjectSqlStorage(this.ctx.storage, {
      maxBytes: 20 * 1024,
      maxUpdates: 1000,
    });
  }
}
```

#### `onStart()`

Override this lifecycle hook (called inside `blockConcurrencyWhile`) to run additional initialization. Always call `super.onStart()`:

```typescript
export class DocProvider extends YStreamProvider<Env> {
  protected override async onStart(): Promise<void> {
    await super.onStart();
    // Custom initialization here
  }
}
```

---

### `YStreamClient`

Synchronizes a local `Y.Doc` with an upstream `YStreamProvider`.

```typescript
import { YStreamClient } from "y-durablestream";
import { Doc } from "yjs";

const doc = new Doc();
const client = new YStreamClient(doc, { stub });
```

#### Constructor

| Parameter | Type | Description |
|---|---|---|
| `doc` | `Doc` | The local Yjs document to synchronize. |
| `options.stub` | `YStreamProviderStub` | The upstream provider's DO stub. |

#### Methods

| Method | Signature | Description |
|---|---|---|
| `connect()` | `() => Promise<void>` | Connect and start syncing. Resolves when the stream ends. Wrap in `ctx.waitUntil()`. |
| `disconnect()` | `() => void` | Disconnect and clean up all resources. Safe to call multiple times. |
| `onStatusChange(handler)` | `(handler: StatusChangeHandler) => () => void` | Register a status change listener. Returns an unsubscribe function. |

#### Properties

| Property | Type | Description |
|---|---|---|
| `status` | `YStreamClientStatus` | Current status: `"disconnected"` \| `"connecting"` \| `"connected"` \| `"synced"` |
| `synced` | `boolean` | Whether initial sync with the provider has completed. |

---

### Storage Backends

#### `DurableObjectKvStorage`

Default backend using the Durable Object async KV API (`ctx.storage.get/put/list/delete`).

```typescript
import { DurableObjectKvStorage } from "y-durablestream";

const storage = new DurableObjectKvStorage(ctx.storage, {
  maxBytes: 10 * 1024,       // optional, default 10KB
  maxUpdates: 500,           // optional, default 500
  snapshotGrowthRatio: 0.25, // optional, default 0.25
});
```

Updates are compacted into the snapshot once they exceed `maxUpdates`, or their bytes exceed `max(maxBytes, snapshot size × snapshotGrowthRatio)`. The ratio keeps a large document from rewriting its whole snapshot for every few KB of edits; set it to `0` for a fixed `maxBytes` threshold. Both backends take the same options.

Storage layout:

| KV Key | Value |
|---|---|
| `ydoc:state:doc` | Compacted snapshot, first 96 KB (`Uint8Array`) |
| `ydoc:state:doc:<n>` | Snapshot chunk n ≥ 1, for snapshots over 96 KB (`Uint8Array`) |
| `ydoc:state:meta` | `{ bytes, count }` of incremental updates |
| `ydoc:state:snapshot-bytes` | Snapshot byte length (`number`) |
| `ydoc:update:<n>` | Incremental update n (`Uint8Array`) |

> `maxBytes` must not exceed 128 KB (the Durable Object KV per-value limit).

#### `DurableObjectSqlStorage`

Alternative backend using the Durable Object synchronous SQLite API (`ctx.storage.sql`).

```typescript
import { DurableObjectSqlStorage } from "y-durablestream";

const storage = new DurableObjectSqlStorage(ctx.storage, {
  maxBytes: 10 * 1024,       // optional, default 10KB
  maxUpdates: 500,           // optional, default 500
  snapshotGrowthRatio: 0.25, // optional, default 0.25
});
```

Advantages over KV:

- **Lower cost** — billed per-row, aggregate queries avoid reading every row
- **Synchronous transactions** — uses `transactionSync()` for truly atomic operations
- **Efficient threshold checks** — `COUNT(*)` / `SUM()` in a single pass

SQL tables created automatically:

| Table | Columns | Description |
|---|---|---|
| `yjs_snapshot` | `id INTEGER PK, data BLOB` | Single-row compacted snapshot (first 1 MB) |
| `yjs_snapshot_chunks` | `idx INTEGER PK, data BLOB` | Remaining 1 MB chunks of a larger snapshot |
| `yjs_updates` | `id INTEGER PK, data BLOB, byte_length INTEGER` | Incremental updates |

> Requires a SQLite-backed Durable Object (`new_sqlite_classes` in `wrangler.toml`).

#### Custom Storage

Implement the `YDocStorage` interface to create your own backend:

```typescript
import type { YDocStorage } from "y-durablestream";
import { Doc } from "yjs";

class MyCustomStorage implements YDocStorage {
  async getYDoc(): Promise<Doc> {
    // Load and return a Doc with all persisted state
  }

  async storeUpdate(update: Uint8Array, doc?: Doc): Promise<void> {
    // Persist an incremental update, auto-compact when thresholds exceeded.
    // `doc` is the live document (already containing `update`); snapshot it
    // on compaction instead of reading stored state back.
  }

  // Optional: apply persisted state straight to the provider's document at
  // startup, skipping the intermediate Doc that getYDoc() builds.
  async loadInto(doc: Doc): Promise<void> {}

  async commit(doc: Doc): Promise<void> {
    // Force-compact all updates into a single snapshot using the given doc
  }
}
```

---

### Protocol Utilities

Low-level framing utilities for the length-prefixed message protocol used over the subscriber stream. You only need these if building custom transport layers.

```typescript
import { encodeFrame, encodeFrames, createFrameDecoder, FrameDecodeError } from "y-durablestream";
```

| Export | Description |
|---|---|
| `encodeFrame(message)` | Encode a single message with a 4-byte big-endian length header. |
| `encodeFrames(messages)` | Encode multiple messages into a single concatenated buffer. |
| `createFrameDecoder()` | Create a stateful decoder that reconstructs messages from arbitrarily chunked stream data. |
| `FrameDecodeError` | Error class thrown when the decoder encounters invalid frame data. |

## How It Works

### Connection Flow

1. Subscriber calls `provider.subscribe()` via RPC, passing its document's state vector
2. Provider registers a consumer on its shared broadcast buffer and returns that consumer's pull-based `ReadableStream`
3. The stream opens with **SyncStep1** (the provider's state vector) + **SyncStep2** (what the subscriber lacks, split across frames when large)
4. Subscriber applies the burst and transitions to `"synced"` status
5. Subscriber answers the provider's SyncStep1 via `provider.update()` with any state the provider is missing (skipped when there is none)

### Steady-State Updates

- **Provider → Subscriber**: when the provider's doc changes (via `applyUpdate()` or from another subscriber), the update is wrapped in a sync Update message, length-framed, and pushed to the broadcast buffer, from which every active subscriber stream pulls it
- **Subscriber → Provider**: when the subscriber's local doc changes, the update is wrapped in a sync Update message and sent via `provider.update()` RPC

### Persistence

Updates are stored incrementally. When the cumulative byte size or count exceeds configurable thresholds, all incremental updates are compacted into a single snapshot. Compaction also runs automatically when the last subscriber disconnects. Snapshots larger than one storage value are split across values, so document size is not capped by the per-value limit. Storage never garbage-collects on its own, so a provider created with `gc: false` keeps its full history across restarts.

### Why Length-Prefixed Framing?

`ReadableStream<Uint8Array>` delivers data in arbitrary chunks — a single `read()` may return part of a message, exactly one message, or multiple messages concatenated together. The 4-byte big-endian length prefix on each frame allows the receiver to reconstruct complete Yjs protocol messages regardless of how the stream chunks the data.

## TypeScript

The package ships with full TypeScript declarations (`.d.ts` and `.d.cts`). Cloudflare Workers types (`DurableObjectState`, etc.) are **not** included as a dependency — they come from your project's `wrangler types` output.

## License

[MIT](./LICENSE) © Sam McCord
