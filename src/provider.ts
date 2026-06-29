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
import { DEFAULT_MAX_FRAME_SIZE, encodeMessage } from "./protocol";
import { DurableObjectKvStorage } from "./storage/kv";


import type { YDocStorage } from "./storage/types";
import type { YStreamProviderOptions } from "./types";

/** Yjs sync protocol outer message type identifier. */
const MESSAGE_SYNC = 0;

/**
 * Byte length of an empty document encoded via `encodeStateAsUpdate`.
 * A freshly created `Y.Doc` with no content encodes to exactly two
 * bytes, so anything larger carries real persisted state worth applying.
 */
const EMPTY_DOC_UPDATE_BYTES = 2;

/**
 * Structured transaction origin used for every applied update. Threaded
 * through `readSyncMessage` / `applyUpdate` so the `doc.on('update')` handler
 * can recover both the originating subscriber (`clientId`, for echo
 * suppression) and the interest routing `key` (for per-consumer filtering).
 * A plain object so it never equals a consumer's `clientId` string nor a
 * client's `this`.
 */
interface BroadcastOrigin {
	clientId?: string;
	key?: string;
}

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

	/**
	 * Maximum size of each frame sent to subscribers, in bytes. Messages larger
	 * than this (notably the full-document `SyncStep2` on connect/resync) are
	 * split into this-sized frames and reassembled by the client, so document
	 * size is no longer bounded by a single frame. Subscribers' decoders must
	 * accept frames at least this large (`YStreamClientOptions.maxFrameSize`).
	 *
	 * @default {@link DEFAULT_MAX_FRAME_SIZE} (1 MB)
	 */
	private readonly frameChunkSize: number;

	constructor(ctx: DurableObjectState, env: E, options?: YStreamProviderOptions) {
		super(ctx, env);
		if (options?.maxBytes !== undefined) this.maxBytes = options.maxBytes;
		if (options?.maxUpdates !== undefined) this.maxUpdates = options.maxUpdates;
		this.frameChunkSize = options?.frameChunkSize ?? DEFAULT_MAX_FRAME_SIZE;
		this.broadcast = new BroadcastBuffer({
			highWaterMark: options?.streamHighWaterMark ?? 64,
			backpressure: options?.backpressure ?? "resync",
			onEmpty: () => {
				// Compact storage once no subscribers remain.  Tie it to
				// the DO lifetime via waitUntil so it isn't dropped if the
				// object is evicted, and never let a storage failure surface
				// as an unhandled rejection.
				this.ctx.waitUntil(
					this.storage.commit(this.doc).catch((err) => {
						this.onStorageError(err);
					}),
				);
			},
			// Supply a fresh burst (scoped to the consumer's interest) so a
			// consumer that falls behind under the "resync" policy converges
			// without losing any deltas — and without re-dumping the whole doc
			// onto an interest-scoped subscriber.
			onResync: (interest) =>
				this.buildInitialFrames(interest ? [...interest] : undefined),
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
		if (state.byteLength > EMPTY_DOC_UPDATE_BYTES) {
			// Only apply if there is meaningful content (an empty doc
			// encodes to a 2-byte update).
			applyUpdate(this.doc, state);
		}

		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			// `origin` is the BroadcastOrigin passed to readSyncMessage/applyUpdate
			// (undefined for the initial state load above). Recover the sender's
			// client id (echo suppression) and the interest routing key.
			const o = origin && typeof origin === "object" ? (origin as BroadcastOrigin) : undefined;
			this.handleDocUpdate(update, o?.clientId, o?.key);
		});
	}

	// ═════════════════════════════════════
	// Public RPC API
	// ═════════════════════════════════════

	/**
	 * Subscribe to the provider's Yjs document.
	 *
	 * @param clientId - Optional stable id for the subscriber.  Pass the
	 *   same id to {@link update} so the provider can avoid echoing the
	 *   subscriber's own changes back to it over this stream.
	 * @param interest - Optional set of routing keys this subscriber wants.
	 *   When provided, it receives only keyless (control) frames and keyed
	 *   updates whose key is in the set, and its initial sync is built via
	 *   {@link buildInitialFrames} with this interest (a subclass filters the
	 *   snapshot accordingly). Omit for full sync.
	 * @returns A `ReadableStream<Uint8Array>` that delivers length-framed
	 *   Yjs sync protocol messages.  The initial burst contains
	 *   SyncStep1 + SyncStep2; subsequent chunks are incremental
	 *   sync Update messages.
	 */
	async subscribe(
		clientId?: string,
		interest?: string[],
	): Promise<ReadableStream<Uint8Array>> {
		const consumer = this.broadcast.createConsumer(
			this.buildInitialFrames(interest),
			clientId,
			interest,
		);
		return consumer.readable;
	}

	/**
	 * Build the initial sync burst for a (re)connecting consumer:
	 * SyncStep1 + SyncStep2 packed into a single framed buffer.
	 *
	 * Delivered as the consumer's `initialFrames` so they are drained
	 * before it starts reading from the shared broadcast buffer.  This
	 * avoids the timing issue of writing data to a stream before the
	 * readable side crosses the RPC boundary, and is reused by the
	 * broadcast buffer's `"resync"` backpressure recovery to bring a
	 * lagging consumer back to the current document state.
	 *
	 * The base implementation sends the **full** document and ignores
	 * `interest`. Override in a subclass to build an interest-scoped snapshot
	 * (only the wanted entities), since the structure of the document — and
	 * thus how a routing key maps to content — is application-specific.
	 *
	 * @param interest - The subscriber's interest set, or `undefined` for full
	 *   sync (also `undefined` on a `"resync"` rebuild, which uses the consumer's
	 *   current interest via {@link createConsumer}).
	 */
	protected buildInitialFrames(interest?: readonly string[]): Uint8Array[] {
		void interest; // full-sync default; subclasses filter by interest
		// Each message is chunked into `frameChunkSize` frames so a full-document
		// SyncStep2 larger than the frame cap is split (and reassembled by the
		// client) rather than rejected. SyncStep1 is small (a single frame).
		return [
			...encodeMessage(createSyncStep1Message(this.doc), this.frameChunkSize),
			...encodeMessage(createSyncStep2Message(this.doc), this.frameChunkSize),
		];
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
	 * @param clientId Optional id matching the one passed to
	 *   {@link subscribe}.  When provided, the resulting change is not
	 *   echoed back to that subscriber's own stream.
	 * @param key Optional interest routing key for the resulting broadcast
	 *   (e.g. the entity id this update concerns). Consumers with an interest
	 *   set receive it only if the key is in their set; omit for a control
	 *   update delivered to all.
	 */
	async update(
		data: Uint8Array,
		clientId?: string,
		key?: string,
	): Promise<Uint8Array | void> {
		const decoder = createDecoder(data);
		const encoder = createEncoder();
		const msgType = readVarUint(decoder);

		if (msgType === MESSAGE_SYNC) {
			writeVarUint(encoder, MESSAGE_SYNC);
			const origin: BroadcastOrigin = { clientId, key };
			readSyncMessage(decoder, encoder, this.doc, origin);

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
	 * @param key Optional interest routing key for the resulting broadcast
	 *   (see {@link update}).
	 */
	async applyUpdate(update: Uint8Array, key?: string): Promise<void> {
		const origin: BroadcastOrigin | undefined = key !== undefined ? { key } : undefined;
		applyUpdate(this.doc, update, origin);
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

	/**
	 * Broadcast an update to every subscriber stream, then persist it.
	 *
	 * Broadcast happens first and synchronously so live sync is never
	 * blocked by (or lost to) a storage failure.  Persistence is then
	 * tied to the DO lifetime via `waitUntil` and its errors are routed
	 * to {@link onStorageError} rather than becoming unhandled
	 * rejections.  If an update fails to persist, it is recovered from a
	 * subscriber on the next SyncStep1/SyncStep2 handshake, so the only
	 * consequence is delayed durability — never silent divergence.
	 */
	private handleDocUpdate(update: Uint8Array, originId?: string, key?: string): void {
		this.broadcastUpdate(update, originId, key);
		this.ctx.waitUntil(
			this.storage.storeUpdate(update).catch((err) => {
				this.onStorageError(err);
			}),
		);
	}

	/**
	 * Hook invoked when a background storage operation (persisting an
	 * update or compacting on the last disconnect) fails.
	 *
	 * The default implementation logs the error.  Override in a subclass
	 * to report to an external monitor or to take corrective action.
	 *
	 * @param error - The error thrown by the storage backend.
	 */
	protected onStorageError(error: unknown): void {
		console.error("[y-durablestream] storage operation failed:", error);
	}

	/**
	 * Push a length-framed sync Update message into the broadcast
	 * buffer where it will be pulled by every active consumer on
	 * their next read.
	 *
	 * The broadcast buffer applies the configured backpressure
	 * policy to slow consumers automatically.
	 *
	 * @param originId - When set, the originating subscriber is not sent
	 *   an echo of its own update (see {@link BroadcastBuffer.push}).
	 * @param key - Interest routing key; consumers with an interest set
	 *   receive this only if the key is in their set (keyless = all).
	 */
	private broadcastUpdate(update: Uint8Array, originId?: string, key?: string): void {
		if (this.broadcast.consumerCount === 0) return;

		// Updates are normally a single frame; a rare oversized update is
		// chunked too, keeping every frame within the cap.
		for (const frame of encodeMessage(createSyncUpdateMessage(update), this.frameChunkSize)) {
			this.broadcast.push(frame, { originId, key });
		}
	}
}
