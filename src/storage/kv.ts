import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import type { YDocStorage, YDocStorageOptions } from "./types";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_UPDATES } from "./types";

// ═══════════════════════════════════════════════════════════
// Storage key constants
// ═══════════════════════════════════════════════════════════

const STATE_DOC_KEY = "ydoc:state:doc";
/**
 * Single meta key holding both compaction counters. One get + one put per
 * stored update instead of two of each with the legacy split keys.
 */
const STATE_META_KEY = "ydoc:state:meta";
/** Legacy (pre-0.9) split counter keys; migrated to STATE_META_KEY on first write. */
const LEGACY_BYTES_KEY = "ydoc:state:bytes";
const LEGACY_COUNT_KEY = "ydoc:state:count";
const UPDATE_KEY_PREFIX = "ydoc:update:";

/** Value stored under {@link STATE_META_KEY}. */
interface StateMeta {
	bytes: number;
	count: number;
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
 * | `ydoc:state:doc`        | `Uint8Array` — compacted doc snapshot |
 * | `ydoc:state:meta`       | `{ bytes, count }` — compaction counters |
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
	private readonly storage: KvStorageLike;

	constructor(
		kvStorage: KvStorageLike,
		options?: YDocStorageOptions,
	) {
		this.storage = kvStorage;
		this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxUpdates = options?.maxUpdates ?? DEFAULT_MAX_UPDATES;

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
		const snapshot = await this.storage.get<Uint8Array>(STATE_DOC_KEY);
		const updates = await this.storage.list<Uint8Array>({
			prefix: UPDATE_KEY_PREFIX,
		});

		const doc = new Doc();

		doc.transact(() => {
			if (snapshot) {
				applyUpdate(doc, snapshot);
			}
			for (const update of updates.values()) {
				applyUpdate(doc, update);
			}
		});

		return doc;
	}

	async storeUpdate(update: Uint8Array): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const { bytes, count } = await this.loadMeta(tx);

			const newBytes = bytes + update.byteLength;
			const newCount = count + 1;

			if (newBytes > this.maxBytes || newCount > this.maxUpdates) {
				// Threshold exceeded — compact everything.
				// Re-read the full state from storage so we are
				// self-contained and do not depend on external doc state.
				const doc = await this.rebuildDoc(tx);
				applyUpdate(doc, update);
				await this.compactInTransaction(tx, doc);
			} else {
				// Common path: 1 get (meta) + 2 puts.
				await tx.put<StateMeta>(STATE_META_KEY, { bytes: newBytes, count: newCount });
				await tx.put(updateKey(newCount), update);
			}
		});
	}

	async commit(doc: Doc): Promise<void> {
		await this.storage.transaction(async (tx) => {
			await this.compactInTransaction(tx, doc);
		});
	}

	// ═════════════════════════════════════
	// Internal helpers
	// ═════════════════════════════════════

	/**
	 * Read the compaction counters, falling back to (and migrating away
	 * from) the legacy pre-0.9 split keys the first time they are seen.
	 */
	private async loadMeta(tx: KvTransactionLike): Promise<StateMeta> {
		const meta = await tx.get<StateMeta>(STATE_META_KEY);
		if (meta) return meta;

		const bytes = await tx.get<number>(LEGACY_BYTES_KEY);
		const count = await tx.get<number>(LEGACY_COUNT_KEY);
		if (bytes === undefined && count === undefined) {
			return { bytes: 0, count: 0 };
		}
		// One-time migration: drop the split keys; the caller writes the
		// merged meta key within this same transaction.
		await tx.delete([LEGACY_BYTES_KEY, LEGACY_COUNT_KEY]);
		return { bytes: bytes ?? 0, count: count ?? 0 };
	}

	/**
	 * Rebuild a `Doc` from the snapshot and incremental updates
	 * currently stored within the given transaction context.
	 */
	private async rebuildDoc(tx: KvTransactionLike): Promise<Doc> {
		const snapshot = await tx.get<Uint8Array>(STATE_DOC_KEY);
		const updates = await tx.list<Uint8Array>({
			prefix: UPDATE_KEY_PREFIX,
		});

		const doc = new Doc();
		doc.transact(() => {
			if (snapshot) {
				applyUpdate(doc, snapshot);
			}
			for (const u of updates.values()) {
				applyUpdate(doc, u);
			}
		});

		return doc;
	}

	/**
	 * Replace all incremental updates with a single compacted snapshot
	 * within the given transaction context.
	 *
	 * @param tx - The current transaction handle.
	 * @param doc - The authoritative document whose encoded state
	 *   becomes the new snapshot.
	 */
	private async compactInTransaction(
		tx: KvTransactionLike,
		doc: Doc,
	): Promise<void> {
		const entries = await tx.list<Uint8Array>({
			prefix: UPDATE_KEY_PREFIX,
		});

		if (entries.size > 0) {
			await tx.delete(Array.from(entries.keys()));
		}

		await tx.put(STATE_DOC_KEY, encodeStateAsUpdate(doc));
		await tx.put<StateMeta>(STATE_META_KEY, { bytes: 0, count: 0 });
	}
}
