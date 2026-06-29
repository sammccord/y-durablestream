/**
 * Internal broadcast buffer for efficiently distributing framed Yjs
 * sync messages to multiple subscribers.
 *
 * Design inspired by the "new streams" proposal's `broadcast()` /
 * `share()` primitives:
 *
 * - A **single shared buffer** holds recently pushed frames.
 * - Each consumer maintains a **cursor** into the buffer.
 * - Consumers are served via **pull-based** `ReadableStream` instances
 *   so data only flows when the consumer is ready.
 * - An explicit {@link BackpressurePolicy} governs what happens when a
 *   slow consumer falls behind the configured high-water mark.
 *
 * @module
 */

import type { BackpressurePolicy } from "./types";

// ─── Internal types ─────────────────────────────────────────────

/** Resolve callback for a consumer waiting for new data. */
type PullResolver = () => void;

/** Per-consumer bookkeeping. */
interface ConsumerState {
	/** Unique id for this consumer. */
	id: number;
	/**
	 * Caller-supplied client id, used to skip echoing a frame back to the
	 * consumer that originated it (see {@link BroadcastBuffer.push}).
	 * `undefined` for consumers that never send updates.
	 */
	clientId: string | undefined;
	/** Position in the shared buffer (absolute index). */
	cursor: number;
	/** Per-consumer initial frames (SyncStep1+2) drained before shared buffer. */
	initialFrames: Uint8Array[];
	/** If the consumer is waiting for data, this resolves the pending pull. */
	resolver: PullResolver | null;
	/** The ReadableStream controller (for enqueue / close / error). */
	controller: ReadableStreamDefaultController<Uint8Array> | null;
	/** Whether the consumer has been cancelled. */
	cancelled: boolean;
}

// ─── Public types ───────────────────────────────────────────────

/** Handle returned by {@link BroadcastBuffer.createConsumer}. */
export interface BroadcastConsumer {
	/** The ReadableStream to return across the RPC boundary. */
	readonly readable: ReadableStream<Uint8Array>;
	/** Cancel and clean up this consumer. */
	cancel(): void;
}

export interface BroadcastBufferOptions {
	/**
	 * Maximum number of frames retained in the shared buffer per
	 * consumer before the backpressure policy kicks in.
	 * @default 64
	 */
	highWaterMark?: number;

	/**
	 * What to do when a consumer falls behind.
	 * @default "resync"
	 */
	backpressure?: BackpressurePolicy;

	/**
	 * Called when the last consumer is removed.
	 * Useful for triggering storage compaction.
	 */
	onEmpty?: () => void;

	/**
	 * Build a fresh full-state initial burst for a consumer that has
	 * fallen behind under the `"resync"` policy.  Returns the frames
	 * (typically a single SyncStep1 + SyncStep2 buffer) that bring the
	 * consumer back to the current document state.
	 *
	 * Required for the `"resync"` policy to recover data correctly.  If
	 * omitted, a lagging consumer under `"resync"` is fast-forwarded to
	 * the buffer head **without** a snapshot, which can diverge a CRDT
	 * subscriber — so a real provider must always supply this.
	 */
	onResync?: () => Uint8Array[];
}

// ─── Implementation ─────────────────────────────────────────────

export class BroadcastBuffer {
	/** Shared ring buffer of framed messages. */
	private buffer: Uint8Array[] = [];

	/**
	 * Absolute index of `buffer[0]`.  Cursors are absolute so that
	 * trimming the front of the buffer doesn't invalidate them.
	 */
	private baseIndex = 0;

	private consumers = new Map<number, ConsumerState>();
	private nextId = 0;

	private readonly highWaterMark: number;
	private readonly backpressure: BackpressurePolicy;
	private readonly onEmpty?: () => void;
	private readonly onResync?: () => Uint8Array[];

	constructor(options?: BroadcastBufferOptions) {
		this.highWaterMark = options?.highWaterMark ?? 64;
		this.backpressure = options?.backpressure ?? "resync";
		this.onEmpty = options?.onEmpty;
		this.onResync = options?.onResync;
	}

	// ── Producer API ──────────────────────────────────────────────

	/**
	 * Push a framed message to all consumers.
	 *
	 * Consumers that are currently waiting (inside a `pull()` call)
	 * are immediately woken.  Consumers that have fallen behind the
	 * high-water mark are handled according to the backpressure
	 * policy.
	 *
	 * @param frame - The framed message to deliver.
	 * @param originId - If set, the caught-up consumer whose `clientId`
	 *   matches is fast-forwarded past this frame so it does not receive
	 *   an echo of its own update.  (A consumer that has fallen behind
	 *   still receives it; re-applying is idempotent in Yjs.)
	 */
	push(frame: Uint8Array, originId?: string): void {
		const headBefore = this.baseIndex + this.buffer.length;
		this.buffer.push(frame);
		const headAfter = this.baseIndex + this.buffer.length;

		// Skip echoing the frame back to its originator when that consumer
		// is fully caught up (the common case for an active editor).
		if (originId !== undefined) {
			for (const consumer of this.consumers.values()) {
				if (
					!consumer.cancelled &&
					consumer.clientId === originId &&
					consumer.cursor === headBefore
				) {
					consumer.cursor = headAfter;
				}
			}
		}

		// Apply backpressure per-consumer before waking them.
		this.applyBackpressure();

		// Wake any consumers that were waiting for data.
		for (const consumer of this.consumers.values()) {
			if (consumer.resolver && !consumer.cancelled) {
				const resolve = consumer.resolver;
				consumer.resolver = null;
				resolve();
			}
		}
	}

	// ── Consumer API ──────────────────────────────────────────────

	/**
	 * Create a new consumer backed by a pull-based `ReadableStream`.
	 *
	 * The consumer first drains any `initialFrames`, then reads from the
	 * shared buffer.
	 *
	 * @param initialFrames - Frames to deliver before the shared buffer.
	 *   Each array element is enqueued as a single stream chunk, and may
	 *   itself contain several concatenated length-prefixed frames (e.g.
	 *   the provider packs SyncStep1 + SyncStep2 into one element).
	 * @param clientId - Optional id identifying the consumer so its own
	 *   updates are not echoed back to it (see {@link push}).
	 */
	createConsumer(
		initialFrames?: Uint8Array[],
		clientId?: string,
	): BroadcastConsumer {
		const id = this.nextId++;

		const state: ConsumerState = {
			id,
			clientId,
			// New consumers start at the current buffer head so they
			// don't receive historical frames (they get initial sync
			// via `initialFrames` instead).
			cursor: this.baseIndex + this.buffer.length,
			initialFrames: initialFrames ? [...initialFrames] : [],
			resolver: null,
			controller: null,
			cancelled: false,
		};

		this.consumers.set(id, state);

		const self = this;

		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				state.controller = controller;
			},

			async pull(controller) {
				// 1. Drain per-consumer initial frames first.
				if (state.initialFrames.length > 0) {
					const frame = state.initialFrames.shift()!;
					controller.enqueue(frame);
					return;
				}

				// 2. Read from shared buffer if data is available.
				const localIndex = state.cursor - self.baseIndex;
				if (localIndex < self.buffer.length) {
					const frame = self.buffer[localIndex];
					state.cursor++;
					controller.enqueue(frame);
					self.tryTrimBuffer();
					return;
				}

				// 3. No data available — wait for the next push().
				await new Promise<void>((resolve) => {
					state.resolver = resolve;
				});

				// Re-check after waking (cursor may have been advanced
				// by backpressure trimming while we were waiting).
				if (state.cancelled) return;

				const idx = state.cursor - self.baseIndex;
				if (idx >= 0 && idx < self.buffer.length) {
					const frame = self.buffer[idx];
					state.cursor++;
					controller.enqueue(frame);
					self.tryTrimBuffer();
				}
			},

			cancel() {
				self.removeConsumer(id);
			},
		});

		const cancel = () => {
			this.removeConsumer(id);
		};

		return { readable, cancel };
	}

	/** Number of active consumers. */
	get consumerCount(): number {
		return this.consumers.size;
	}

	/**
	 * Number of frames currently retained in the shared buffer.
	 *
	 * Exposed for diagnostics and tests — under the `"resync"` and
	 * `"error"` policies this stays bounded by the high-water mark even
	 * when a consumer stalls.
	 */
	get bufferedFrameCount(): number {
		return this.buffer.length;
	}

	// ── Internals ─────────────────────────────────────────────────

	/**
	 * Remove a consumer and clean up its state.
	 * Triggers `onEmpty` callback if this was the last consumer.
	 */
	removeConsumer(id: number): void {
		const consumer = this.consumers.get(id);
		if (!consumer) return;

		consumer.cancelled = true;

		// Resolve any pending pull so the stream can close.
		if (consumer.resolver) {
			const resolve = consumer.resolver;
			consumer.resolver = null;
			resolve();
		}

		// Close the ReadableStream.
		try {
			consumer.controller?.close();
		} catch {
			// Already closed or errored — safe to ignore.
		}

		this.consumers.delete(id);
		this.tryTrimBuffer();

		if (this.consumers.size === 0) {
			this.onEmpty?.();
		}
	}

	/**
	 * Apply the configured backpressure policy to consumers that have
	 * fallen behind the high-water mark.
	 *
	 * Neither policy ever skips an incremental delta — doing so would
	 * permanently diverge a CRDT subscriber.  `"resync"` recovers the
	 * consumer with a fresh full-state snapshot; `"error"` disconnects
	 * it so it can reconnect.
	 */
	private applyBackpressure(): void {
		const head = this.baseIndex + this.buffer.length;

		// Collect lagging consumers first so we never mutate the
		// `consumers` map while iterating it (the "error" policy removes
		// entries) and never re-enter applyBackpressure via removeConsumer.
		const lagging: ConsumerState[] = [];
		for (const consumer of this.consumers.values()) {
			if (consumer.cancelled) continue;
			if (head - consumer.cursor <= this.highWaterMark) continue;
			lagging.push(consumer);
		}

		if (lagging.length === 0) return;

		for (const consumer of lagging) {
			if (this.backpressure === "error") {
				// Disconnect the slow consumer.
				try {
					consumer.controller?.error(
						new Error("Subscriber too slow: backpressure overflow"),
					);
				} catch {
					// Already errored — ignore.
				}
				this.removeConsumer(consumer.id);
				continue;
			}

			// "resync": fast-forward the consumer to the buffer head and
			// hand it a fresh full-state snapshot.  Dropping its claim on
			// the old frames lets the buffer be trimmed (bounding memory),
			// and the snapshot guarantees convergence with no lost deltas.
			consumer.initialFrames = this.onResync ? this.onResync() : [];
			consumer.cursor = head;
		}

		// Reclaim buffer entries no consumer needs any more now that the
		// laggards have been fast-forwarded.
		this.tryTrimBuffer();
	}

	/**
	 * Trim buffer entries that no consumer needs any more.
	 *
	 * Finds the minimum cursor across all consumers and discards
	 * everything before it.
	 */
	private tryTrimBuffer(): void {
		if (this.consumers.size === 0) {
			// No consumers — drop everything.
			this.baseIndex += this.buffer.length;
			this.buffer.length = 0;
			return;
		}

		let minCursor = Infinity;
		for (const consumer of this.consumers.values()) {
			if (consumer.cursor < minCursor) {
				minCursor = consumer.cursor;
			}
		}

		const trimCount = minCursor - this.baseIndex;
		if (trimCount > 0) {
			this.buffer.splice(0, trimCount);
			this.baseIndex += trimCount;
		}
	}
}
