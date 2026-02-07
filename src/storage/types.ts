import type { Doc } from "yjs";

/**
 * Abstract storage backend for persisting Yjs document state.
 *
 * Implementations handle the mechanics of storing incremental updates
 * and compacting them into snapshots.  The {@link YStreamProvider}
 * delegates all persistence to an instance of this interface, making
 * the storage layer fully swappable.
 *
 * Two built-in implementations are provided:
 *
 * - {@link DurableObjectKvStorage} — uses the Durable Object async KV
 *   API (`ctx.storage.get/put/list/delete`).
 * - {@link DurableObjectSqlStorage} — uses the Durable Object
 *   synchronous SQLite API (`ctx.storage.sql`), which is cheaper on
 *   the billing model and offers a synchronous transaction API.
 */
export interface YDocStorage {
	/**
	 * Load the full persisted document state into a new `Y.Doc`.
	 *
	 * The implementation should reconstruct the document from whatever
	 * combination of snapshot + incremental updates it stores.
	 *
	 * @returns A new `Doc` containing all persisted state. If no state
	 *   has ever been persisted, returns an empty `Doc`.
	 */
	getYDoc(): Promise<Doc>;

	/**
	 * Persist a single incremental Yjs document update.
	 *
	 * Implementations should buffer updates and auto-compact them into
	 * a snapshot when the cumulative byte size or count exceeds the
	 * configured thresholds.
	 *
	 * @param update - A raw Yjs encoded update (from `doc.on('update')`
	 *   or `Y.encodeStateAsUpdate`).
	 */
	storeUpdate(update: Uint8Array): Promise<void>;

	/**
	 * Force-compact all incremental updates into a single snapshot.
	 *
	 * Uses the provided `doc` as the source of truth (since it is
	 * always the most up-to-date representation of the document).
	 *
	 * Called automatically by the provider when the last subscriber
	 * disconnects, ensuring storage is in a clean compacted state.
	 *
	 * @param doc - The current in-memory `Y.Doc` whose full state
	 *   should be persisted as the new snapshot.
	 */
	commit(doc: Doc): Promise<void>;
}

/**
 * Configuration options shared by all storage implementations.
 */
export interface YDocStorageOptions {
	/**
	 * Maximum total bytes of incremental updates stored before
	 * automatic compaction into a snapshot.
	 *
	 * For KV storage this must not exceed 128 KB (the Durable Object
	 * KV storage per-value limit).
	 *
	 * @default 10240 (10 KB)
	 */
	maxBytes?: number;

	/**
	 * Maximum number of incremental updates stored before automatic
	 * compaction into a snapshot.
	 *
	 * @default 500
	 */
	maxUpdates?: number;
}

/**
 * Default compaction threshold: 10 KB of accumulated update bytes.
 */
export const DEFAULT_MAX_BYTES = 10 * 1024;

/**
 * Default compaction threshold: 500 incremental updates.
 */
export const DEFAULT_MAX_UPDATES = 500;
