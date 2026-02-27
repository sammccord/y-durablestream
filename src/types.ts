import type { Doc } from "yjs";

/**
 * The RPC surface exposed by a YStreamProvider Durable Object.
 * This is the interface that client stubs conform to.
 */
export interface YStreamProviderStub {
	/**
	 * Subscribe to the provider's Yjs document.
	 * Returns a ReadableStream of length-framed Yjs sync protocol messages.
	 */
	subscribe(): Promise<ReadableStream<Uint8Array>>;

	/**
	 * Send a Yjs sync protocol message to the provider.
	 * Used by clients to push local document updates upstream.
	 *
	 * May return a response message (e.g. a SyncStep2 in reply to a
	 * SyncStep1) that the caller should process.
	 */
	update(data: Uint8Array): Promise<Uint8Array | void>;

	/**
	 * Get the full Yjs document state as a single encoded update.
	 */
	getYDoc(): Promise<Uint8Array>;
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
	 * Enable automatic reconnection when the stream drops.
	 *
	 * Pass `true` for sensible defaults or a {@link ReconnectOptions}
	 * object for fine-grained control.
	 *
	 * When disabled (the default), `connect()` resolves when the stream
	 * ends and the caller must re-invoke it manually.
	 */
	reconnect?: boolean | ReconnectOptions;
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
 * - `"drop-oldest"` – discard the oldest buffered frames so the slow
 *   consumer jumps ahead.  Best for real-time Yjs sync where the
 *   latest document state subsumes all previous states.
 * - `"drop-newest"` – discard the incoming frame when the buffer is
 *   full.  Suitable when every frame must eventually be consumed.
 * - `"error"` – disconnect the slowest consumer when the buffer
 *   overflows.
 */
export type BackpressurePolicy = "drop-oldest" | "drop-newest" | "error";

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
	 * @default "drop-oldest"
	 */
	backpressure?: BackpressurePolicy;

	/**
	 * Maximum number of frames buffered per subscriber before the
	 * backpressure policy is applied.
	 * @default 64
	 */
	streamHighWaterMark?: number;
}
