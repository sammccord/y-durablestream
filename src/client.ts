import { createDecoder, readVarUint } from "lib0/decoding";
import {
	createEncoder,
	length,
	toUint8Array,
	writeVarUint,
} from "lib0/encoding";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";

import { createFrameDecoder } from "./protocol";

import type { Doc } from "yjs";
import type { FrameDecoder } from "./protocol";
import type {
	StatusChangeHandler,
	YStreamClientOptions,
	YStreamClientStatus,
	YStreamProviderStub,
} from "./types";

/** Yjs sync protocol outer message type identifier. */
const MESSAGE_SYNC = 0;

/**
 * y-protocols/sync messageYjsSyncStep2 constant.
 * After receiving and processing a SyncStep2, the client considers
 * itself fully synchronised with the provider.
 */
const SYNC_STEP_2 = 1;

/**
 * A client that synchronises a local `Y.Doc` with an upstream
 * {@link YStreamProvider} Durable Object via `ReadableStream`.
 *
 * ## Lifecycle
 *
 * 1. Construct the client with a `Y.Doc` and a provider stub.
 * 2. Call {@link connect} — it returns a `Promise` that resolves when
 *    the stream ends or is disconnected.  Wrap it in `ctx.waitUntil()`
 *    inside a Durable Object.
 * 3. Call {@link disconnect} to tear down the connection and remove
 *    all listeners.
 *
 * ## Sync protocol
 *
 * On connection the provider sends SyncStep1 + SyncStep2.  The client:
 *
 * - Processes **SyncStep1** — this produces a SyncStep2 reply (carrying
 *   any data the provider lacks), which is sent back via `stub.update()`.
 * - Processes **SyncStep2** — applies the full document state to the
 *   local doc and transitions to `"synced"` status.
 *
 * After initial sync, incremental updates flow in both directions:
 *
 * - **Provider → Client**: streamed as sync Update messages via the
 *   `ReadableStream`.
 * - **Client → Provider**: sent back via `stub.update()` whenever the
 *   local doc changes.
 *
 * @example
 * ```ts
 * import { DurableObject } from "cloudflare:workers";
 * import { Doc } from "yjs";
 * import { YStreamClient } from "y-durablestream";
 *
 * export class MyDO extends DurableObject<Env> {
 *   private doc = new Doc();
 *   private client: YStreamClient | null = null;
 *
 *   async sync(upstreamName: string): Promise<void> {
 *     const stub = this.env.Y_STREAM_PROVIDER.getByName(upstreamName);
 *     this.client = new YStreamClient(this.doc, { stub });
 *     this.ctx.waitUntil(this.client.connect());
 *   }
 * }
 * ```
 */
export class YStreamClient {
	private readonly doc: Doc;
	private readonly stub: YStreamProviderStub;

	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private decoder: FrameDecoder | null = null;

	private _status: YStreamClientStatus = "disconnected";
	private _synced = false;

	/**
	 * Set to `true` by {@link disconnect} to signal that the client
	 * should stop.  Checked by {@link connect} after async operations
	 * to detect a disconnect that happened during setup.
	 */
	private _disposed = false;

	/** Registered doc 'update' handler, stored so it can be removed. */
	private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null =
		null;

	/** Status-change listeners. */
	private statusListeners = new Set<StatusChangeHandler>();

	constructor(doc: Doc, options: YStreamClientOptions) {
		this.doc = doc;
		this.stub = options.stub;
	}

	// ═════════════════════════════════════
	// Public API
	// ═════════════════════════════════════

	/**
	 * The current connection/sync status of the client.
	 *
	 * - `"disconnected"` – not connected.
	 * - `"connecting"` – `subscribe()` has been called but initial sync
	 *   has not completed.
	 * - `"connected"` – the stream is open and initial messages are
	 *   being processed.
	 * - `"synced"` – the client has received and applied SyncStep2 from
	 *   the provider.  The local doc matches the upstream state and
	 *   incremental updates are flowing.
	 */
	get status(): YStreamClientStatus {
		return this._status;
	}

	/**
	 * Whether the initial sync with the provider has completed.
	 * Remains `true` until the client is disconnected.
	 */
	get synced(): boolean {
		return this._synced;
	}

	/**
	 * Register a listener that fires whenever the client status changes.
	 *
	 * @param handler Callback receiving the new status.
	 * @returns An unsubscribe function.
	 */
	onStatusChange(handler: StatusChangeHandler): () => void {
		this.statusListeners.add(handler);
		return () => {
			this.statusListeners.delete(handler);
		};
	}

	/**
	 * Connect to the upstream provider and start synchronising.
	 *
	 * The returned `Promise` **always resolves** (never rejects) so it
	 * is safe to pass directly to `ctx.waitUntil()`.  It resolves when
	 * the stream ends — either because the provider closed it, a
	 * network error occurred, or {@link disconnect} was called.
	 *
	 * Calling `connect()` while already connected is a no-op — it
	 * returns immediately without error.
	 */
	async connect(): Promise<void> {
		if (this._status !== "disconnected") {
			return;
		}

		this._disposed = false;
		this.setStatus("connecting");

		let stream: ReadableStream<Uint8Array>;
		try {
			stream = await this.stub.subscribe();
		} catch {
			this.setStatus("disconnected");
			return;
		}

		// If disconnect() was called while we were awaiting subscribe(),
		// abort immediately without entering the read loop.
		if (this._disposed) {
			this.teardown();
			return;
		}

		this.setStatus("connected");
		this.decoder = createFrameDecoder();
		this.reader = stream.getReader();

		// Register local doc update handler to push changes upstream.
		this.updateHandler = (update: Uint8Array, origin: unknown) => {
			// Do not echo back updates that originated from the provider.
			if (origin === this) {
				return;
			}
			this.sendUpdate(update);
		};
		this.doc.on("update", this.updateHandler);

		// Send our own SyncStep1 to the provider so it knows what we
		// already have.  The provider will respond with a SyncStep2 if
		// we had data it was missing.
		this.sendSyncStep1();

		// Enter the read loop — this runs until the stream ends or we
		// disconnect.  readLoop() always resolves (never rejects).
		await this.readLoop();

		// Clean up resources after the read loop exits.
		// This is the ONLY place teardown is called during an active
		// connection — disconnect() deliberately does NOT call it,
		// avoiding the double-cleanup race that causes unhandled
		// rejections.
		this.teardown();
	}

	/**
	 * Disconnect from the upstream provider.
	 *
	 * Cancels the underlying `ReadableStream` reader, which causes the
	 * read loop inside {@link connect} to exit.  The `connect()` method
	 * then calls {@link teardown} to release all resources.
	 *
	 * This method intentionally does **not** call `teardown()` itself —
	 * doing so would race with `connect()`'s teardown and create
	 * duplicate `reader.cancel()` / `reader.releaseLock()` calls that
	 * surface as unhandled promise rejections in the workerd runtime.
	 *
	 * Safe to call multiple times or when not connected.
	 */
	disconnect(): void {
		if (this._status === "disconnected") {
			return;
		}

		// Signal that the client is shutting down.  This is checked by
		// connect() after async operations to detect a disconnect that
		// happened during setup (before readLoop starts).
		this._disposed = true;

		// Cancel the reader to unblock the read loop.  The returned
		// promise rejection (if any) is swallowed — the read loop's
		// .then(_, onRejected) handler will observe the cancellation
		// and exit cleanly, after which connect() calls teardown().
		if (this.reader) {
			this.reader.cancel().catch(() => {});
		}
	}

	// ═════════════════════════════════════
	// Internal: stream reading
	// ═════════════════════════════════════

	/**
	 * Continuously read from the stream, decode frames, and process
	 * each complete Yjs sync protocol message.
	 *
	 * Uses `.then(onFulfilled, onRejected)` instead of `try/catch` on
	 * `await` so that the rejection handler is attached **synchronously**
	 * at the moment `reader.read()` is called.  This prevents the
	 * workerd runtime from observing a transiently "unhandled" rejection
	 * in the microtask gap between when the promise rejects and when an
	 * async `catch` block would run.
	 *
	 * Always resolves — never rejects.
	 */
	private async readLoop(): Promise<void> {
		const reader = this.reader;
		const decoder = this.decoder;
		if (!reader || !decoder) return;

		let active = true;

		while (active) {
			// Attach both handlers synchronously via .then() so the
			// rejection handler is registered before the next microtask.
			await reader.read().then(
				({ done, value }) => {
					if (done) {
						active = false;
						return;
					}

					const messages = decoder.push(value);
					for (const msg of messages) {
						this.handleMessage(msg);
					}
				},
				() => {
					// Stream was cancelled (disconnect) or the network
					// connection was lost.  Exit the loop cleanly.
					active = false;
				},
			);
		}
	}

	/**
	 * Process a single complete Yjs sync protocol message received from
	 * the upstream provider.
	 *
	 * @param data - A complete Yjs sync protocol message (the payload
	 *   inside a length-prefixed frame, without the frame header).
	 */
	private handleMessage(data: Uint8Array): void {
		const msgDecoder = createDecoder(data);
		const encoder = createEncoder();
		const msgType = readVarUint(msgDecoder);

		if (msgType !== MESSAGE_SYNC) {
			// Only sync messages are supported; ignore unknown types.
			return;
		}

		writeVarUint(encoder, MESSAGE_SYNC);
		const syncMessageType = readSyncMessage(
			msgDecoder,
			encoder,
			this.doc,
			this,
		);

		// readSyncMessage returns the sync sub-message type:
		//   0 = SyncStep1 (state vector request)
		//   1 = SyncStep2 (state response / full doc)
		//   2 = Update    (incremental change)

		// If processing a SyncStep1 produced a SyncStep2 response,
		// send it back to the provider.
		if (length(encoder) > 1) {
			void this.stub.update(toUint8Array(encoder));
		}

		// Transition to "synced" after receiving SyncStep2.
		if (syncMessageType === SYNC_STEP_2 && !this._synced) {
			this._synced = true;
			this.setStatus("synced");
		}
	}

	// ═════════════════════════════════════
	// Internal: sending to provider
	// ═════════════════════════════════════

	/**
	 * Send a SyncStep1 message to the provider.
	 * This tells the provider our state vector so it can determine
	 * whether there is any data we already have that it lacks.
	 */
	private sendSyncStep1(): void {
		const encoder = createEncoder();
		writeVarUint(encoder, MESSAGE_SYNC);
		writeSyncStep1(encoder, this.doc);
		void this.stub.update(toUint8Array(encoder));
	}

	/**
	 * Wrap a raw Yjs doc update in a sync Update message and send it
	 * to the provider.
	 */
	private sendUpdate(update: Uint8Array): void {
		const encoder = createEncoder();
		writeVarUint(encoder, MESSAGE_SYNC);
		writeUpdate(encoder, update);
		void this.stub.update(toUint8Array(encoder));
	}

	// ═════════════════════════════════════
	// Internal: lifecycle
	// ═════════════════════════════════════

	/**
	 * Release all resources.  Called exclusively by {@link connect}
	 * after the read loop exits — never by {@link disconnect}.
	 *
	 * Does **not** cancel the reader (that is disconnect's job).
	 * Only cleans up references so the client can be reconnected or
	 * garbage-collected.
	 *
	 * Idempotent — safe to call repeatedly.
	 */
	private teardown(): void {
		if (this.updateHandler) {
			this.doc.off("update", this.updateHandler);
			this.updateHandler = null;
		}

		if (this.reader) {
			try {
				this.reader.releaseLock();
			} catch {
				// Reader may already be released or the stream errored.
			}
			this.reader = null;
		}

		if (this.decoder) {
			this.decoder.reset();
			this.decoder = null;
		}

		this._synced = false;
		this.setStatus("disconnected");
	}

	/**
	 * Update the status and notify all registered listeners.
	 */
	private setStatus(status: YStreamClientStatus): void {
		if (this._status === status) return;
		this._status = status;
		for (const listener of this.statusListeners) {
			try {
				listener(status);
			} catch {
				// Don't let a misbehaving listener break the client.
			}
		}
	}
}
