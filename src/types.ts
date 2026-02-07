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
	 */
	update(data: Uint8Array): Promise<void>;

	/**
	 * Get the full Yjs document state as a single encoded update.
	 */
	getYDoc(): Promise<Uint8Array>;
}

/**
 * Options for constructing a YStreamClient.
 */
export interface YStreamClientOptions {
	/** The upstream YStreamProvider DO stub to connect to. */
	stub: YStreamProviderStub;
}

/**
 * Connection state of a YStreamClient.
 */
export type YStreamClientStatus = "disconnected" | "connecting" | "connected" | "synced";

/**
 * Callback for status change events.
 */
export type StatusChangeHandler = (status: YStreamClientStatus) => void;

/**
 * A subscriber session tracked by the provider.
 * Maps a writable stream writer to its cleanup/unsubscribe function.
 */
export interface StreamSession {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	unsubscribe: () => void;
}

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
}
