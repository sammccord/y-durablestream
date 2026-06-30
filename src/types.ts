import type { Doc } from "yjs";

/**
 * The RPC surface exposed by a YStreamProvider Durable Object.
 * This is the interface that client stubs conform to.
 */
export interface YStreamProviderStub {
	/**
	 * Subscribe to the provider's Yjs document.
	 * Returns a ReadableStream of length-framed Yjs sync protocol messages.
	 *
	 * @param clientId Optional stable id for this subscriber.  Pass the
	 *   same id to {@link update} so the provider does not echo the
	 *   subscriber's own changes back over this stream.
	 * @param interest Optional set of routing keys this subscriber wants. When
	 *   provided, it receives only keyless (control) frames and keyed updates
	 *   whose key is in the set, and an interest-scoped initial sync. Omit for
	 *   full sync.
	 */
	subscribe(clientId?: string, interest?: string[]): Promise<ReadableStream<Uint8Array>>;

	/**
	 * Send a Yjs sync protocol message to the provider.
	 * Used by clients to push local document updates upstream.
	 *
	 * May return a response message (e.g. a SyncStep2 in reply to a
	 * SyncStep1) that the caller should process.
	 *
	 * @param data The Yjs sync protocol message.
	 * @param clientId Optional id matching the one passed to
	 *   {@link subscribe}, enabling the provider to suppress the echo of
	 *   this update back to the sender.
	 * @param key Optional interest routing key for the resulting broadcast
	 *   (e.g. the entity id this update concerns). Consumers with an interest
	 *   set receive it only if the key is in their set; omit for a control
	 *   update delivered to all.
	 */
	update(data: Uint8Array, clientId?: string, key?: string): Promise<Uint8Array | void>;

	/**
	 * Get the full Yjs document state as a single encoded update.
	 */
	getYDoc(): Promise<Uint8Array>;

	/**
	 * Register a push-subscriber so the provider delivers live updates by RPC
	 * (via its `pushToSubscriber` hook) rather than over a stream — the delivery
	 * path for Durable Object subscribers whose stream read-loop cannot outlive
	 * the request that opened it. Persisted; idempotent.
	 *
	 * @param clientId Stable subscriber id; MUST match the `clientId` passed to
	 *   {@link update} so the subscriber's own writes are not echoed back.
	 * @param address Opaque routing info handed back to the provider's
	 *   `pushToSubscriber` (e.g. the subscriber DO's binding name + id).
	 */
	register(clientId: string, address: unknown): Promise<void>;

	/** Remove a push-subscriber registered via {@link register}. Idempotent. */
	deregister(clientId: string): Promise<void>;
}

/**
 * Reconnection strategy for {@link YStreamClient}.
 */
export interface ReconnectOptions {
	/**
	 * Maximum number of reconnection attempts before giving up.
	 * @default Infinity
	 */
	maxRetries?: number;

	/**
	 * Initial delay in milliseconds before the first retry.
	 * @default 100
	 */
	initialDelay?: number;

	/**
	 * Maximum delay in milliseconds between retries.
	 * @default 30000
	 */
	maxDelay?: number;

	/**
	 * Multiplier applied to the delay after each failed attempt.
	 * @default 2
	 */
	backoffMultiplier?: number;
}

/**
 * Options for constructing a YStreamClient.
 */
export interface YStreamClientOptions {
	/** The upstream YStreamProvider DO stub to connect to. */
	stub: YStreamProviderStub;

	/**
	 * Stable client id sent with `subscribe`/`update`/`syncOnce` so the provider
	 * can suppress echoing this client's own writes (and, with notify-push, match
	 * this client to its `register(clientId, ...)` entry). Defaults to a random
	 * UUID. Set this to a stable per-subscriber value (e.g. the lobby namespace)
	 * when you also call `register` / `pushLocalUpdate` so all three agree.
	 */
	clientId?: string;

	/**
	 * Enable automatic reconnection when the stream drops.
	 *
	 * Pass `true` for sensible defaults or a {@link ReconnectOptions}
	 * object for fine-grained control.
	 *
	 * When disabled (the default), `connect()` resolves when the stream
	 * ends and the caller must re-invoke it manually.
	 */
	reconnect?: boolean | ReconnectOptions;

	/**
	 * Maximum decodable frame payload, in bytes. The full-document initial
	 * sync arrives as a single frame, so raise this above the 1 MB default to
	 * sync larger documents. Must be ≥ the largest frame the provider sends.
	 *
	 * @default 1048576 (1 MB)
	 */
	maxFrameSize?: number;

	/**
	 * Interest set of routing keys passed to `subscribe`. When provided, the
	 * provider streams only keyless (control) frames and keyed updates whose
	 * key is in the set, plus an interest-scoped initial sync. Omit for full
	 * sync. Outgoing local updates are keyed by their transaction origin's
	 * `key` (set `doc.transact(fn, { key })` so the change routes to the right
	 * interest); updates with no key broadcast to all.
	 */
	interest?: string[];
}

/**
 * Connection state of a YStreamClient.
 */
export type YStreamClientStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "synced"
	| "reconnecting";

/**
 * Callback for status change events.
 */
export type StatusChangeHandler = (status: YStreamClientStatus) => void;

/**
 * Backpressure policy applied to the broadcast buffer when a slow
 * subscriber falls behind the configured high-water mark.
 *
 * The streamed frames after initial sync are **incremental Yjs update
 * deltas**, not snapshots.  Silently dropping a delta would leave the
 * subscriber permanently diverged: every later update that causally
 * depends on the dropped one stays pending in Yjs forever and never
 * applies.  Therefore neither policy ever discards a delta.
 *
 * - `"resync"` – when a consumer falls behind, deliver a fresh
 *   full-state snapshot (a new SyncStep1 + SyncStep2 burst) and resume
 *   it from the buffer head.  The consumer converges to the current
 *   document state with no data loss, and the buffer is reclaimed.
 *   This is the safe default for CRDT sync.
 * - `"error"` – disconnect the slow consumer.  It is free to reconnect,
 *   which performs a full resync from scratch.
 */
export type BackpressurePolicy = "resync" | "error";

/**
 * Options for constructing a YStreamProvider.
 */
export interface YStreamProviderOptions {
	/**
	 * Maximum bytes of incremental updates to store before compacting.
	 * @default 10240 (10KB)
	 */
	maxBytes?: number;

	/**
	 * Maximum number of incremental updates to store before compacting.
	 * @default 500
	 */
	maxUpdates?: number;

	/**
	 * Whether to enable garbage collection on the Yjs document.
	 * @default true
	 */
	gc?: boolean;

	/**
	 * Backpressure policy for the broadcast buffer.
	 * Controls what happens when a subscriber falls behind.
	 * @default "resync"
	 */
	backpressure?: BackpressurePolicy;

	/**
	 * Maximum number of frames buffered per subscriber before the
	 * backpressure policy is applied.
	 * @default 64
	 */
	streamHighWaterMark?: number;

	/**
	 * Maximum size of each frame sent to subscribers, in bytes. The
	 * full-document initial sync is split into frames of this size and
	 * reassembled by the client, so document size is not bounded by a single
	 * frame. Subscribers' `YStreamClientOptions.maxFrameSize` must be ≥ this.
	 *
	 * @default 1048576 (1 MB)
	 */
	frameChunkSize?: number;
}
