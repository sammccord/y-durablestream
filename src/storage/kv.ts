import { applyUpdate, encodeStateAsUpdate } from "yjs";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_UPDATES,
	DEFAULT_SNAPSHOT_GROWTH_RATIO,
	createCarrierDoc,
	joinChunks,
	splitIntoChunks,
} from "./types";

import type { YDocStorage, YDocStorageOptions } from "./types";
import type { Doc } from "yjs";

// ═══════════════════════════════════════════════════════════
// Storage key constants
// ═══════════════════════════════════════════════════════════

/** First snapshot chunk — the whole snapshot when it fits in one value. */
const STATE_DOC_KEY = "ydoc:state:doc";
/** Further snapshot chunks: `ydoc:state:doc:<n>` for n ≥ 1, in order. */
const STATE_DOC_CHUNK_PREFIX = "ydoc:state:doc:";
/**
 * Snapshot chunk size. Kept under the smallest Durable Object per-value
 * limit (128 KiB on the KV-backed storage backend; 2 MB on SQLite-backed)
 * so a snapshot of any size persists on either.
 */
const SNAPSHOT_CHUNK_BYTES = 96 * 1024;
/** `delete(keys)` accepts at most this many keys per call. */
const MAX_KEYS_PER_DELETE = 128;
const chunkKey = (n: number) => `${STATE_DOC_CHUNK_PREFIX}${String(n).padStart(8, "0")}`;
/**
 * Single meta key holding both compaction counters. One get + one put per
 * stored update instead of two of each with the legacy split keys.
 */
const STATE_META_KEY = "ydoc:state:meta";
/** Byte length of the current snapshot, written at each compaction. */
const SNAPSHOT_BYTES_KEY = "ydoc:state:snapshot-bytes";
/** Legacy (pre-0.9) split counter keys; migrated to STATE_META_KEY on first write. */
const LEGACY_BYTES_KEY = "ydoc:state:bytes";
const LEGACY_COUNT_KEY = "ydoc:state:count";
const UPDATE_KEY_PREFIX = "ydoc:update:";

/** Value stored under {@link STATE_META_KEY}. */
interface StateMeta {
	bytes: number;
	count: number;
}

/** In-memory compaction counters: the stored meta plus the snapshot size. */
interface Counters extends StateMeta {
	snapshotBytes: number;
}
/**
 * Zero-pad the update index so that `list({ prefix })`, which returns
 * keys in lexicographic order, yields updates in numeric insertion order
 * (otherwise `:10` would sort before `:2`).  20 digits covers the full
 * 64-bit range.  Yjs tolerates out-of-order application, but ordered
 * keys keep the snapshot deterministic and debugging sane.
 */
const updateKey = (n: number) => `${UPDATE_KEY_PREFIX}${String(n).padStart(20, "0")}`;

/**
 * Minimal subset of `DurableObjectStorage` / `DurableObjectTransaction`
 * used by this implementation.  Declared here so that the module does
 * not depend on the full Cloudflare worker types at compile time.
 */
interface KvStorageLike {
	get<T = unknown>(key: string): Promise<T | undefined>;
	list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
	put<T>(key: string, value: T): Promise<void>;
	delete(keys: string[]): Promise<number>;
	transaction<T>(closure: (txn: KvTransactionLike) => Promise<T>): Promise<T>;
}

interface KvTransactionLike {
	get<T = unknown>(key: string): Promise<T | undefined>;
	list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
	put<T>(key: string, value: T): Promise<void>;
	delete(keys: string[]): Promise<number>;
}

/**
 * Yjs document storage backed by the Durable Object async KV API.
 *
 * This is the default storage implementation used by
 * {@link YStreamProvider}.  It stores the document as a combination
 * of a single compacted snapshot and a series of incremental updates.
 * When the cumulative byte size or count of incremental updates
 * exceeds the configured thresholds, the updates are automatically
 * compacted into a new snapshot.
 *
 * ## Storage layout (KV keys)
 *
 * | Key                     | Value                                 |
 * |-------------------------|---------------------------------------|
 * | `ydoc:state:doc`        | `Uint8Array` — snapshot (first chunk) |
 * | `ydoc:state:doc:<n>`    | `Uint8Array` — snapshot chunk `n` ≥ 1 |
 * | `ydoc:state:meta`       | `{ bytes, count }` — compaction counters |
 * | `ydoc:state:snapshot-bytes` | `number` — snapshot byte length    |
 * | `ydoc:update:<n>`       | `Uint8Array` — incremental update `n` |
 *
 * (Pre-0.9 layouts with split `ydoc:state:bytes` / `ydoc:state:count` keys
 * are migrated to `ydoc:state:meta` on the first write.)
 *
 * ## Usage
 *
 * ```ts
 * const storage = new DurableObjectKvStorage(ctx.storage);
 * ```
 *
 * @param kvStorage - A `DurableObjectStorage` instance (typically
 *   `ctx.storage`).
 * @param options - Optional compaction threshold overrides.
 */
export class DurableObjectKvStorage implements YDocStorage {
	private readonly maxBytes: number;
	private readonly maxUpdates: number;
	private readonly snapshotGrowthRatio: number;
	private readonly storage: KvStorageLike;

	/**
	 * Compaction counters, read from storage once and then maintained in
	 * memory so a stored update costs two puts and no read. Safe because a
	 * Durable Object's storage is exclusive to this instance and all writes
	 * go through this class. Dropped (and re-read) after a failed transaction,
	 * whose rollback does not undo the in-memory changes.
	 */
	private counters: Promise<Counters> | null = null;

	constructor(
		kvStorage: KvStorageLike,
		options?: YDocStorageOptions,
	) {
		this.storage = kvStorage;
		this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxUpdates = options?.maxUpdates ?? DEFAULT_MAX_UPDATES;
		this.snapshotGrowthRatio = options?.snapshotGrowthRatio ?? DEFAULT_SNAPSHOT_GROWTH_RATIO;

		if (this.maxBytes > 128 * 1024) {
			throw new Error(
				"maxBytes must not exceed 128 KB (Durable Object KV per-value limit)",
			);
		}
	}

	// ═════════════════════════════════════
	// YDocStorage implementation
	// ═════════════════════════════════════

	async getYDoc(): Promise<Doc> {
		const doc = createCarrierDoc();
		await this.loadInto(doc);
		return doc;
	}

	async loadInto(doc: Doc): Promise<void> {
		await this.applyStoredState(this.storage, doc);
	}

	async storeUpdate(update: Uint8Array, doc?: Doc): Promise<void> {
		await this.transact(async (tx, counters) => {
			// Counters change synchronously, before any further await, so
			// overlapping calls never compute the same update key.
			counters.bytes += update.byteLength;
			counters.count += 1;

			const byteLimit = Math.max(
				this.maxBytes,
				counters.snapshotBytes * this.snapshotGrowthRatio,
			);
			if (
				counters.bytes > byteLimit ||
				counters.count > this.maxUpdates ||
				update.byteLength > SNAPSHOT_CHUNK_BYTES
			) {
				// Threshold exceeded (or the update is too large for one value) —
				// compact. The live doc, when given, already holds this update;
				// otherwise rebuild the state from storage.
				counters.bytes = 0;
				counters.count = 0;
				let source = doc;
				if (!source) {
					source = createCarrierDoc();
					await this.applyStoredState(tx, source);
					applyUpdate(source, update);
				}
				await this.writeCompacted(tx, counters, source);
			} else {
				// Common path: 2 puts, no read.
				const key = updateKey(counters.count);
				await tx.put<StateMeta>(STATE_META_KEY, {
					bytes: counters.bytes,
					count: counters.count,
				});
				await tx.put(key, update);
			}
		});
	}

	async commit(doc: Doc): Promise<void> {
		await this.transact(async (tx, counters) => {
			counters.bytes = 0;
			counters.count = 0;
			await this.writeCompacted(tx, counters, doc);
		});
	}

	// ═════════════════════════════════════
	// Internal helpers
	// ═════════════════════════════════════

	/** Run `closure` in a storage transaction with the compaction counters. */
	private async transact(
		closure: (tx: KvTransactionLike, counters: Counters) => Promise<void>,
	): Promise<void> {
		try {
			await this.storage.transaction(async (tx) => {
				this.counters ??= this.loadCounters(tx);
				await closure(tx, await this.counters);
			});
		} catch (error) {
			this.counters = null;
			throw error;
		}
	}

	/**
	 * Read the compaction counters, falling back to (and migrating away
	 * from) the legacy pre-0.9 split keys the first time they are seen.
	 */
	private async loadCounters(tx: KvTransactionLike): Promise<Counters> {
		const snapshotBytes = (await tx.get<number>(SNAPSHOT_BYTES_KEY)) ?? 0;
		const meta = await tx.get<StateMeta>(STATE_META_KEY);
		if (meta) return { bytes: meta.bytes, count: meta.count, snapshotBytes };

		const bytes = await tx.get<number>(LEGACY_BYTES_KEY);
		const count = await tx.get<number>(LEGACY_COUNT_KEY);
		if (bytes === undefined && count === undefined) {
			return { bytes: 0, count: 0, snapshotBytes };
		}
		// One-time migration: drop the split keys; the caller writes the
		// merged meta key within this same transaction.
		await tx.delete([LEGACY_BYTES_KEY, LEGACY_COUNT_KEY]);
		return { bytes: bytes ?? 0, count: count ?? 0, snapshotBytes };
	}

	/**
	 * Apply the stored snapshot and incremental updates to `doc`.
	 */
	private async applyStoredState(tx: KvTransactionLike, doc: Doc): Promise<void> {
		const snapshot = await this.readSnapshot(tx);
		const updates = await tx.list<Uint8Array>({
			prefix: UPDATE_KEY_PREFIX,
		});

		doc.transact(() => {
			if (snapshot) {
				applyUpdate(doc, snapshot);
			}
			for (const u of updates.values()) {
				applyUpdate(doc, u);
			}
		});
	}

	/** Read the snapshot, reassembling it from its chunks. */
	private async readSnapshot(tx: KvTransactionLike): Promise<Uint8Array | undefined> {
		const first = await tx.get<Uint8Array>(STATE_DOC_KEY);
		if (!first) return undefined;
		const rest = await tx.list<Uint8Array>({ prefix: STATE_DOC_CHUNK_PREFIX });
		return joinChunks([first, ...rest.values()]);
	}

	/** Delete keys in batches the storage API accepts. */
	private async deleteKeys(tx: KvTransactionLike, keys: string[]): Promise<void> {
		for (let i = 0; i < keys.length; i += MAX_KEYS_PER_DELETE) {
			await tx.delete(keys.slice(i, i + MAX_KEYS_PER_DELETE));
		}
	}

	/**
	 * Replace the snapshot and all incremental updates with the encoded
	 * state of `doc`. The caller has already zeroed the update counters.
	 */
	private async writeCompacted(
		tx: KvTransactionLike,
		counters: Counters,
		doc: Doc,
	): Promise<void> {
		const updates = await tx.list<Uint8Array>({ prefix: UPDATE_KEY_PREFIX });
		const oldChunks = await tx.list<Uint8Array>({ prefix: STATE_DOC_CHUNK_PREFIX });
		await this.deleteKeys(tx, [...updates.keys(), ...oldChunks.keys()]);

		const snapshot = encodeStateAsUpdate(doc);
		counters.snapshotBytes = snapshot.byteLength;
		const chunks = splitIntoChunks(snapshot, SNAPSHOT_CHUNK_BYTES);
		for (const [index, chunk] of chunks.entries()) {
			await tx.put(index === 0 ? STATE_DOC_KEY : chunkKey(index), chunk);
		}
		await tx.put<StateMeta>(STATE_META_KEY, { bytes: 0, count: 0 });
		await tx.put(SNAPSHOT_BYTES_KEY, snapshot.byteLength);
	}
}
