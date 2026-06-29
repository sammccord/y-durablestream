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

/** A buffered frame plus its optional routing key (entity id, etc.). */
interface BufferEntry {
	frame: Uint8Array;
	/** Interest routing key; `undefined` = control frame delivered to all. */
	key: string | undefined;
}

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
	/**
	 * Interest set of routing keys. `null` means "interested in everything"
	 * (the full-sync default). Otherwise the consumer receives only keyless
	 * (control) frames and keyed frames whose key is in this set.
	 */
	interest: Set<string> | null;
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
	/**
	 * Update this consumer's interest set (for a consumer created with an
	 * interest set; a no-op for a full-sync `null`-interest consumer). Newly
	 * added keys take effect for frames pushed afterwards; the caller is
	 * responsible for separately delivering current state for added keys
	 * (e.g. a mini-snapshot). Removed keys simply stop being delivered.
	 */
	setInterest(change: { add?: Iterable<string>; remove?: Iterable<string> }): void;
}

/** Options for {@link BroadcastBuffer.push}. */
export interface PushOptions {
	/**
	 * If set, the caught-up consumer whose `clientId` matches is fast-forwarded
	 * past this frame so it does not receive an echo of its own update.
	 */
	originId?: string;
	/**
	 * Routing key for interest filtering. A consumer with an interest set
	 * receives this frame only if its set contains `key`. Omit for a control
	 * frame delivered to every consumer regardless of interest.
	 */
	key?: string;
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
	 *
	 * Receives the lagging consumer's interest set (`null` for full sync) so
	 * the rebuilt snapshot is scoped to what that consumer actually wants.
	 */
	onResync?: (interest: Set<string> | null) => Uint8Array[];
}

// ─── Implementation ─────────────────────────────────────────────

export class BroadcastBuffer {
	/** Shared ring buffer of framed messages (each with its routing key). */
	private buffer: BufferEntry[] = [];

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
	private readonly onResync?: (interest: Set<string> | null) => Uint8Array[];

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
	 * @param opts - Optional routing: `originId` (echo suppression) and `key`
	 *   (interest filtering). See {@link PushOptions}.
	 */
	push(frame: Uint8Array, opts?: PushOptions): void {
		const originId = opts?.originId;
		const headBefore = this.baseIndex + this.buffer.length;
		this.buffer.push({ frame, key: opts?.key });
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
	 * @param interest - Optional set of routing keys this consumer wants. When
	 *   provided, the consumer receives only keyless (control) frames and keyed
	 *   frames whose key is in the set. Omit (or pass `null`) for full sync.
	 */
	createConsumer(
		initialFrames?: Uint8Array[],
		clientId?: string,
		interest?: Iterable<string> | null,
	): BroadcastConsumer {
		const id = this.nextId++;

		const state: ConsumerState = {
			id,
			clientId,
			interest: interest == null ? null : new Set(interest),
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

				// 2. Deliver the next frame this consumer is interested in.
				//    takeNext may skip (advance past) non-interest frames, so
				//    trim after it even when nothing is delivered — otherwise a
				//    consumer that skips everything would advance its cursor but
				//    never let the buffer reclaim those frames.
				let frame = self.takeNext(state);
				self.tryTrimBuffer();
				if (frame !== null) {
					controller.enqueue(frame);
					return;
				}

				// 3. No deliverable data — wait for the next push()/setInterest.
				await new Promise<void>((resolve) => {
					state.resolver = resolve;
				});
				if (state.cancelled) return;

				frame = self.takeNext(state);
				self.tryTrimBuffer();
				if (frame !== null) {
					controller.enqueue(frame);
				}
			},

			cancel() {
				self.removeConsumer(id);
			},
		});

		const cancel = () => {
			this.removeConsumer(id);
		};

		const setInterest = (change: { add?: Iterable<string>; remove?: Iterable<string> }) => {
			this.setConsumerInterest(id, change);
		};

		return { readable, cancel, setInterest };
	}

	/**
	 * Advance `state.cursor` past frames this consumer is not interested in and
	 * return the next deliverable frame, or `null` if it has reached the buffer
	 * head. Skipping non-interest frames here (rather than enqueuing them) is
	 * what makes per-consumer interest filtering work over the shared buffer —
	 * and it advances the cursor, so skipped frames never starve trimming.
	 */
	private takeNext(state: ConsumerState): Uint8Array | null {
		for (;;) {
			let idx = state.cursor - this.baseIndex;
			if (idx < 0) {
				// Cursor fell behind the trimmed head (shouldn't happen with
				// resync); resnap to the base to stay safe.
				state.cursor = this.baseIndex;
				idx = 0;
			}
			if (idx >= this.buffer.length) return null;
			const entry = this.buffer[idx];
			state.cursor++;
			if (this.isInterested(state, entry)) return entry.frame;
		}
	}

	/** Whether `state` wants `entry`: keyless frames + matching keyed frames. */
	private isInterested(state: ConsumerState, entry: BufferEntry): boolean {
		if (entry.key === undefined) return true; // control frame → everyone
		if (state.interest === null) return true; // full-sync consumer
		return state.interest.has(entry.key);
	}

	/**
	 * Mutate a consumer's interest set and wake it (newly-added keys may match
	 * already-buffered frames). No-op for a full-sync (`null`-interest) consumer.
	 */
	private setConsumerInterest(
		id: number,
		change: { add?: Iterable<string>; remove?: Iterable<string> },
	): void {
		const consumer = this.consumers.get(id);
		if (!consumer || consumer.cancelled || consumer.interest === null) return;
		for (const k of change.add ?? []) consumer.interest.add(k);
		for (const k of change.remove ?? []) consumer.interest.delete(k);
		if (consumer.resolver) {
			const resolve = consumer.resolver;
			consumer.resolver = null;
			resolve();
		}
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
			consumer.initialFrames = this.onResync ? this.onResync(consumer.interest) : [];
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
