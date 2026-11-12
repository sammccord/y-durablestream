import { Doc } from "yjs";

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
	 * @param doc - The live document, already containing `update`. When
	 *   given, a compaction snapshots it directly instead of reading the
	 *   stored snapshot and updates back and replaying them. The provider
	 *   always passes it.
	 */
	storeUpdate(update: Uint8Array, doc?: Doc): Promise<void>;

	/**
	 * Apply all persisted state directly to `doc`.
	 *
	 * Optional. When implemented, the provider loads through it at startup
	 * rather than {@link getYDoc}, which builds a second document only to
	 * re-encode it.
	 */
	loadInto?(doc: Doc): Promise<void>;

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

	/**
	 * Lets the byte threshold grow with the document: updates are compacted
	 * once their bytes exceed `max(maxBytes, snapshotBytes × ratio)`. Each
	 * compaction rewrites the whole snapshot, so a fixed `maxBytes` makes a
	 * large document rewrite itself for every few KB of edits; with the
	 * ratio, bytes written stay proportional to bytes edited. `0` disables
	 * scaling. `maxUpdates` still applies unchanged.
	 *
	 * @default 0.25
	 */
	snapshotGrowthRatio?: number;
}

/**
 * Default compaction threshold: 10 KB of accumulated update bytes.
 */
export const DEFAULT_MAX_BYTES = 10 * 1024;

/**
 * Default compaction threshold: 500 incremental updates.
 */
export const DEFAULT_MAX_UPDATES = 500;

/**
 * Default {@link YDocStorageOptions.snapshotGrowthRatio}.
 */
export const DEFAULT_SNAPSHOT_GROWTH_RATIO = 0.25;

/**
 * Split `data` into consecutive chunks of at most `chunkBytes` each. Data
 * that fits is returned as-is in a single chunk. Otherwise each chunk is a
 * copy, not a view: structured-clone storage serializes a view's entire
 * backing buffer, which would defeat the split.
 */
export function splitIntoChunks(data: Uint8Array, chunkBytes: number): Uint8Array[] {
	if (data.byteLength <= chunkBytes) return [data];
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
		chunks.push(data.slice(offset, offset + chunkBytes));
	}
	return chunks;
}

/** Concatenate chunks produced by {@link splitIntoChunks} back into one buffer. */
export function joinChunks(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0];
	let length = 0;
	for (const chunk of chunks) length += chunk.byteLength;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Create the scratch document a storage backend rebuilds persisted state
 * into. Garbage collection is off: this document only carries bytes between
 * storage and the provider, and collecting here would strip deleted content
 * that a `gc: false` provider must keep. A `gc: true` provider still
 * collects when it applies the state to its own document.
 */
export function createCarrierDoc(): Doc {
	return new Doc({ gc: false });
}
