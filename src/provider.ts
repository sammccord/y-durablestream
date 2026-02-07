import { DurableObject } from "cloudflare:workers";
import { createDecoder, readVarUint } from "lib0/decoding";
import {
	createEncoder,
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

import { encodeFrame, encodeFrames } from "./protocol";
import { DurableObjectKvStorage } from "./storage/kv";

import type { YDocStorage } from "./storage/types";
import type { StreamSession } from "./types";

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

	/** Active subscriber stream sessions. */
	private sessions = new Set<StreamSession>();

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

	constructor(ctx: DurableObjectState, env: E) {
		super(ctx, env);
		this.doc = new Doc({ gc: true });
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
		const { readable, writable } = new TransformStream<
			Uint8Array,
			Uint8Array
		>();
		const writer = writable.getWriter();

		const session: StreamSession = {
			writer,
			unsubscribe: () => {},
		};
		this.sessions.add(session);

		// Build the initial sync burst: SyncStep1 + SyncStep2.
		// IMPORTANT: We must NOT write data to the stream before returning
		// the ReadableStream.  Data buffered in a TransformStream before
		// the readable side crosses the RPC boundary may be lost.  Instead
		// we schedule the write to execute after this method returns so the
		// caller has attached a reader first.
		const initialFrame = encodeFrames([
			createSyncStep1Message(this.doc),
			createSyncStep2Message(this.doc),
		]);

		void this.sendInitialSync(session, initialFrame);

		return readable;
	}

	/**
	 * Write the initial sync burst to a newly registered session.
	 * Runs asynchronously after {@link subscribe} returns so that
	 * the `ReadableStream` has crossed the RPC boundary and the
	 * caller has had a chance to attach a reader.
	 *
	 * Uses `.then(_, onRejected)` to attach the rejection handler
	 * synchronously, preventing a transiently "unhandled" rejection
	 * in the workerd runtime.
	 */
	private async sendInitialSync(
		session: StreamSession,
		frame: Uint8Array,
	): Promise<void> {
		await session.writer.write(frame).then(
			() => {},
			() => {
				this.removeSession(session);
			},
		);
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
	async update(data: Uint8Array): Promise<void> {
		const decoder = createDecoder(data);
		const encoder = createEncoder();
		const msgType = readVarUint(decoder);

		if (msgType === MESSAGE_SYNC) {
			writeVarUint(encoder, MESSAGE_SYNC);
			readSyncMessage(decoder, encoder, this.doc, "y-stream-remote");
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
	 * Write a length-framed sync Update message to every active
	 * subscriber stream.  Sessions whose writers have errored are
	 * removed automatically.
	 *
	 * Uses `.then(_, onRejected)` to attach rejection handlers
	 * synchronously, preventing transiently "unhandled" rejections
	 * in the workerd runtime.
	 */
	private broadcastUpdate(update: Uint8Array): void {
		if (this.sessions.size === 0) return;

		const frame = encodeFrame(createSyncUpdateMessage(update));

		for (const session of this.sessions) {
			session.writer.write(frame).then(
				() => {},
				() => {
					this.removeSession(session);
				},
			);
		}
	}

	/**
	 * Tear down a subscriber session and release its resources.
	 * When the last session is removed, storage is compacted.
	 *
	 * Avoids calling `writer.close()` because the writer may already
	 * be in an errored state (e.g. the subscriber disconnected), and
	 * closing an errored writer creates a secondary promise rejection
	 * that surfaces as "Network connection lost" in the workerd
	 * runtime.  Instead we simply release the writer lock — the
	 * underlying stream will be garbage-collected.
	 */
	private removeSession(session: StreamSession): void {
		if (!this.sessions.has(session)) return;

		session.unsubscribe();
		this.sessions.delete(session);

		try {
			session.writer.releaseLock();
		} catch {
			// Writer may already be released.
		}

		// Compact storage when the last subscriber disconnects.
		if (this.sessions.size === 0) {
			void this.storage.commit(this.doc);
		}
	}
}
