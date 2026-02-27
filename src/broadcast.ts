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
	 * @default "drop-oldest"
	 */
	backpressure?: BackpressurePolicy;

	/**
	 * Called when the last consumer is removed.
	 * Useful for triggering storage compaction.
	 */
	onEmpty?: () => void;
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

	constructor(options?: BroadcastBufferOptions) {
		this.highWaterMark = options?.highWaterMark ?? 64;
		this.backpressure = options?.backpressure ?? "drop-oldest";
		this.onEmpty = options?.onEmpty;
	}

	// ── Producer API ──────────────────────────────────────────────

	/**
	 * Push a framed message to all consumers.
	 *
	 * Consumers that are currently waiting (inside a `pull()` call)
	 * are immediately woken.  Consumers that have fallen behind the
	 * high-water mark are handled according to the backpressure
	 * policy.
	 */
	push(frame: Uint8Array): void {
		this.buffer.push(frame);

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
	 * The consumer first drains any `initialFrames` (the per-subscriber
	 * SyncStep1+2 burst), then reads from the shared buffer.
	 */
	createConsumer(initialFrames?: Uint8Array[]): BroadcastConsumer {
		const id = this.nextId++;

		const state: ConsumerState = {
			id,
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
	 */
	private applyBackpressure(): void {
		for (const consumer of this.consumers.values()) {
			if (consumer.cancelled) continue;

			const lag = this.baseIndex + this.buffer.length - consumer.cursor;
			if (lag <= this.highWaterMark) continue;

			switch (this.backpressure) {
				case "drop-oldest":
					// Advance the slow consumer's cursor to keep it within
					// the high-water mark, effectively skipping old frames.
					consumer.cursor = this.baseIndex + this.buffer.length - this.highWaterMark;
					break;

				case "drop-newest":
					// Nothing to do per-consumer; we simply won't enqueue
					// data beyond the high-water mark on the next pull.
					break;

				case "error":
					// Disconnect the slow consumer.
					try {
						consumer.controller?.error(
							new Error("Subscriber too slow: backpressure overflow"),
						);
					} catch {
						// Already errored — ignore.
					}
					this.removeConsumer(consumer.id);
					break;
			}
		}
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
