import { DurableObject } from "cloudflare:workers";
import { createDecoder, readVarUint } from "lib0/decoding";
import {
	createEncoder,
	length,
	toUint8Array,
	writeVarUint,
} from "lib0/encoding";
import {
	readSyncMessage,
	writeSyncStep1,
	writeSyncStep2,
	writeUpdate,
} from "y-protocols/sync";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import { BroadcastBuffer } from "./broadcast";
import { encodeFrame, encodeFrames } from "./protocol";
import { DurableObjectKvStorage } from "./storage/kv";


import type { YDocStorage } from "./storage/types";
import type { YStreamProviderOptions } from "./types";

/** Yjs sync protocol outer message type identifier. */
const MESSAGE_SYNC = 0;

// ═══════════════════════════════════════════════════════════
// Sync message helpers
// ═══════════════════════════════════════════════════════════

/**
 * Create a sync protocol message containing SyncStep1 (state vector).
 * The subscriber should process this and respond with a SyncStep2 via
 * {@link YStreamProvider.update} to send any data the provider lacks.
 */
function createSyncStep1Message(doc: Doc): Uint8Array {
	const encoder = createEncoder();
	writeVarUint(encoder, MESSAGE_SYNC);
	writeSyncStep1(encoder, doc);
	return toUint8Array(encoder);
}

/**
 * Create a sync protocol message containing SyncStep2 (full doc state).
 * This delivers the entire document content to a new subscriber so it
 * can be applied immediately without waiting for a round-trip.
 */
function createSyncStep2Message(doc: Doc): Uint8Array {
	const encoder = createEncoder();
	writeVarUint(encoder, MESSAGE_SYNC);
	writeSyncStep2(encoder, doc);
	return toUint8Array(encoder);
}

/**
 * Create a sync protocol message wrapping an incremental Y.Doc update.
 * Used for broadcasting changes after the initial sync has completed.
 */
function createSyncUpdateMessage(update: Uint8Array): Uint8Array {
	const encoder = createEncoder();
	writeVarUint(encoder, MESSAGE_SYNC);
	writeUpdate(encoder, update);
	return toUint8Array(encoder);
}

// ═══════════════════════════════════════════════════════════
// YStreamProvider
// ═══════════════════════════════════════════════════════════

/**
 * A Durable Object that hosts an authoritative Yjs document and streams
 * document updates to subscriber Durable Objects via `TransformStream`.
 *
 * ## Subscription protocol
 *
 * Subscribers call {@link subscribe} to obtain a `ReadableStream<Uint8Array>`
 * of length-framed Yjs sync protocol messages.  On connection the full
 * document state is pushed immediately as:
 *
 * 1. **SyncStep1** – the provider's state vector.  The subscriber should
 *    process this (which produces a SyncStep2 response carrying any data
 *    the provider is missing) and send it back via {@link update}.
 * 2. **SyncStep2** – the complete document content so the subscriber has
 *    the full doc without waiting for the SyncStep1 round-trip.
 *
 * After the initial burst, incremental updates are streamed as
 * sync Update messages whenever the document changes.
 *
 * Subscribers push their own changes back to the provider by calling
 * {@link update} with a Yjs sync protocol message.
 *
 * ## Persistence
 *
 * Document state is persisted via a pluggable {@link YDocStorage}
 * backend.  The default uses the Durable Object async KV API.
 * Override {@link createStorage} in a subclass to use a different
 * backend (e.g. {@link DurableObjectSqlStorage}).
 *
 * @typeParam E - The environment bindings type for this Durable Object.
 *
 * @example
 * ```ts
 * // Default KV storage
 * export class DocProvider extends YStreamProvider<Env> {}
 *
 * // SQLite storage
 * import { DurableObjectSqlStorage } from "y-stream";
 * export class SqlDocProvider extends YStreamProvider<Env> {
 *   protected override createStorage() {
 *     return new DurableObjectSqlStorage(this.ctx.storage);
 *   }
 * }
 * ```
 */
export class YStreamProvider<E = unknown> extends DurableObject<E> {
	// ═════════════════════════════════════
	// State
	// ═════════════════════════════════════

	/** The authoritative Yjs document. */
	protected doc: Doc;

	/** The pluggable storage backend for persistence. */
	protected storage: YDocStorage;

	/**
	 * Shared broadcast buffer that distributes framed updates to
	 * all active subscriber streams.  Replaces the per-session
	 * `TransformStream` + `WritableStreamDefaultWriter` model
	 * with a single shared buffer and per-consumer cursors.
	 */
	private broadcast!: BroadcastBuffer;

	// ═════════════════════════════════════
	// Configurable thresholds
	// ═════════════════════════════════════

	/**
	 * Maximum total bytes of incremental updates stored before automatic
	 * compaction into a snapshot.  Override in a subclass constructor
	 * (before `super()` returns) or in {@link createStorage}.
	 *
	 * For KV storage this must not exceed 128 KB (Durable Object KV
	 * per-value limit).
	 *
	 * @default 10240 (10 KB)
	 */
	protected maxBytes = 10 * 1024;

	/**
	 * Maximum number of incremental updates stored before automatic
	 * compaction into a snapshot.  Override in a subclass constructor
	 * (before `super()` returns) or in {@link createStorage}.
	 *
	 * @default 500
	 */
	protected maxUpdates = 500;

	constructor(ctx: DurableObjectState, env: E, options?: YStreamProviderOptions) {
		super(ctx, env);
		if (options?.maxBytes !== undefined) this.maxBytes = options.maxBytes;
		if (options?.maxUpdates !== undefined) this.maxUpdates = options.maxUpdates;
		this.broadcast = new BroadcastBuffer({
			highWaterMark: options?.streamHighWaterMark ?? 64,
			backpressure: options?.backpressure ?? "drop-oldest",
			onEmpty: () => {
				void this.storage.commit(this.doc);
			},
		});
		this.doc = new Doc({ gc: options?.gc ?? true });
		this.storage = this.createStorage();
		void this.ctx.blockConcurrencyWhile(() => this.onStart());
	}

	/**
	 * Factory method that creates the storage backend.
	 *
	 * Override this in a subclass to use a different persistence
	 * implementation.  The method is called once during construction,
	 * **after** {@link maxBytes} and {@link maxUpdates} have been
	 * initialised but **before** {@link onStart}.
	 *
	 * @returns A {@link YDocStorage} instance.
	 *
	 * @example
	 * ```ts
	 * import { DurableObjectSqlStorage } from "y-stream";
	 *
	 * export class SqlDocProvider extends YStreamProvider<Env> {
	 *   protected override createStorage() {
	 *     return new DurableObjectSqlStorage(this.ctx.storage, {
	 *       maxBytes: this.maxBytes,
	 *       maxUpdates: this.maxUpdates,
	 *     });
	 *   }
	 * }
	 * ```
	 */
	protected createStorage(): YDocStorage {
		return new DurableObjectKvStorage(this.ctx.storage, {
			maxBytes: this.maxBytes,
			maxUpdates: this.maxUpdates,
		});
	}

	/**
	 * Lifecycle hook executed inside `blockConcurrencyWhile` during
	 * construction.  Loads persisted state and wires up the document
	 * update handler.
	 *
	 * Subclasses may override this but **must** call `super.onStart()`.
	 */
	protected async onStart(): Promise<void> {
		const persisted = await this.storage.getYDoc();
		const state = encodeStateAsUpdate(persisted);
		if (state.byteLength > 2) {
			// Only apply if there is meaningful content (an empty doc
			// encodes to a 2-byte update).
			applyUpdate(this.doc, state);
		}

		this.doc.on("update", (update: Uint8Array) => {
			void this.handleDocUpdate(update);
		});
	}

	// ═════════════════════════════════════
	// Public RPC API
	// ═════════════════════════════════════

	/**
	 * Subscribe to the provider's Yjs document.
	 *
	 * @returns A `ReadableStream<Uint8Array>` that delivers length-framed
	 *   Yjs sync protocol messages.  The initial burst contains
	 *   SyncStep1 + SyncStep2; subsequent chunks are incremental
	 *   sync Update messages.
	 */
	async subscribe(): Promise<ReadableStream<Uint8Array>> {
		// Build the per-subscriber initial sync burst: SyncStep1 + SyncStep2.
		// These are delivered as the consumer's `initialFrames` so they are
		// drained before the consumer starts reading from the shared
		// broadcast buffer.  This avoids the timing issue of writing data
		// to a TransformStream before the readable side crosses the RPC
		// boundary.
		const initialFrames = [
			encodeFrames([
				createSyncStep1Message(this.doc),
				createSyncStep2Message(this.doc),
			]),
		];

		const consumer = this.broadcast.createConsumer(initialFrames);
		return consumer.readable;
	}

	/**
	 * Receive a Yjs sync protocol message from a subscriber.
	 *
	 * The message **must** include the outer sync message type prefix
	 * (`0`).  Typical payloads are:
	 *
	 * - **SyncStep2** – the subscriber's response to the provider's
	 *   SyncStep1, carrying any data the provider is missing.
	 * - **Update** – an incremental document change from the subscriber.
	 *
	 * Applied updates trigger persistence and broadcast to all active
	 * subscribers automatically via the document's `update` event.
	 *
	 * @param data A complete Yjs sync protocol message (not length-framed).
	 */
	async update(data: Uint8Array): Promise<Uint8Array | void> {
		const decoder = createDecoder(data);
		const encoder = createEncoder();
		const msgType = readVarUint(decoder);

		if (msgType === MESSAGE_SYNC) {
			writeVarUint(encoder, MESSAGE_SYNC);
			readSyncMessage(decoder, encoder, this.doc, "y-stream-remote");

			// If readSyncMessage produced a response (e.g. a SyncStep2 reply
			// to a client's SyncStep1), return it so the caller can process it.
			if (length(encoder) > 1) {
				return toUint8Array(encoder);
			}
		}
	}

	/**
	 * Apply a raw Yjs document update directly — **not** wrapped in
	 * sync protocol framing.
	 *
	 * Use this for programmatic mutations originating inside the
	 * Durable Object itself rather than from a subscriber.
	 *
	 * Triggers persistence and broadcast to all active subscribers.
	 *
	 * @param update A Yjs encoded document update (`Y.encodeStateAsUpdate`
	 *   or the `update` argument from a `doc.on('update')` handler).
	 */
	async applyUpdate(update: Uint8Array): Promise<void> {
		applyUpdate(this.doc, update);
	}

	/**
	 * Return the full Yjs document state encoded as a single update.
	 *
	 * Equivalent to `Y.encodeStateAsUpdate(doc)`.  Useful for
	 * snapshotting, debugging, or bootstrapping a new replica without
	 * going through the streaming protocol.
	 */
	async getYDoc(): Promise<Uint8Array> {
		return encodeStateAsUpdate(this.doc);
	}

	// ═════════════════════════════════════
	// Internal: update handling
	// ═════════════════════════════════════

	/** Persist an update then broadcast it to every subscriber stream. */
	private async handleDocUpdate(update: Uint8Array): Promise<void> {
		await this.storage.storeUpdate(update);
		this.broadcastUpdate(update);
	}

	/**
	 * Push a length-framed sync Update message into the broadcast
	 * buffer where it will be pulled by every active consumer on
	 * their next read.
	 *
	 * The broadcast buffer applies the configured backpressure
	 * policy to slow consumers automatically.
	 */
	private broadcastUpdate(update: Uint8Array): void {
		if (this.broadcast.consumerCount === 0) return;

		const frame = encodeFrame(createSyncUpdateMessage(update));
		this.broadcast.push(frame);
	}
}
