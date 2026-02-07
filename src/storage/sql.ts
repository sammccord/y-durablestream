import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import type { YDocStorage, YDocStorageOptions } from "./types";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_UPDATES } from "./types";

// ═══════════════════════════════════════════════════════════
// Minimal type definitions for the Cloudflare SQL storage API
// ═══════════════════════════════════════════════════════════

/**
 * Minimal subset of `SqlStorage` (`ctx.storage.sql`) used by this
 * implementation.  Declared here so the module does not depend on the
 * full Cloudflare worker types at compile time.
 */
interface SqlStorageLike {
	exec<T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): SqlCursorLike<T>;
}

type SqlStorageValue = ArrayBuffer | string | number | null;

interface SqlCursorLike<T> {
	toArray(): T[];
	one(): T;
}

/**
 * Minimal subset of `DurableObjectStorage` required by this
 * implementation.  Needs the `sql` property and `transactionSync`.
 */
interface SqlCapableStorage {
	readonly sql: SqlStorageLike;
	transactionSync<T>(closure: () => T): T;
}

// ═══════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS yjs_snapshot (
		id          INTEGER PRIMARY KEY CHECK (id = 1),
		data        BLOB NOT NULL
	);

	CREATE TABLE IF NOT EXISTS yjs_updates (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		data        BLOB NOT NULL,
		byte_length INTEGER NOT NULL
	);
`;

// ═══════════════════════════════════════════════════════════
// Row types returned by queries
// ═══════════════════════════════════════════════════════════

interface SnapshotRow {
	[key: string]: SqlStorageValue;
	data: ArrayBuffer;
}

interface UpdateRow {
	[key: string]: SqlStorageValue;
	data: ArrayBuffer;
}

interface AggregateRow {
	[key: string]: SqlStorageValue;
	total_count: number;
	total_bytes: number;
}

// ═══════════════════════════════════════════════════════════
// DurableObjectSqlStorage
// ═══════════════════════════════════════════════════════════

/**
 * Yjs document storage backed by the Durable Object SQLite API
 * (`ctx.storage.sql`).
 *
 * This implementation offers several advantages over the KV-backed
 * alternative:
 *
 * - **Lower cost** — SQLite storage is billed per-row rather than
 *   per-KV operation, and aggregation queries avoid reading every
 *   row individually.
 * - **Synchronous transactions** — uses `ctx.storage.transactionSync()`
 *   for truly atomic operations without async interleaving.
 * - **Efficient compaction** — aggregate queries (`COUNT`, `SUM`)
 *   compute thresholds in a single pass without listing all keys.
 *
 * ## Storage layout (SQL tables)
 *
 * | Table            | Description                             |
 * |------------------|-----------------------------------------|
 * | `yjs_snapshot`   | Single-row table holding the compacted  |
 * |                  | document snapshot (`BLOB`).             |
 * | `yjs_updates`    | Incremental updates with auto-inc id    |
 * |                  | and byte length for threshold checks.   |
 *
 * ## Requirements
 *
 * The Durable Object **must** use the SQLite storage backend
 * (declared as `new_sqlite_classes` in `wrangler.toml` migrations).
 *
 * ## Usage
 *
 * ```ts
 * export class DocProvider extends YStreamProvider<Env> {
 *   protected override createStorage(): YDocStorage {
 *     return new DurableObjectSqlStorage(this.ctx.storage);
 *   }
 * }
 * ```
 *
 * @param storage - A `DurableObjectStorage` instance (typically
 *   `ctx.storage`) that exposes the `sql` and `transactionSync`
 *   properties.
 * @param options - Optional compaction threshold overrides.
 */
export class DurableObjectSqlStorage implements YDocStorage {
	private readonly maxBytes: number;
	private readonly maxUpdates: number;
	private readonly sql: SqlStorageLike;
	private readonly storage: SqlCapableStorage;

	constructor(storage: SqlCapableStorage, options?: YDocStorageOptions) {
		this.storage = storage;
		this.sql = storage.sql;
		this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxUpdates = options?.maxUpdates ?? DEFAULT_MAX_UPDATES;

		// Ensure tables exist.  This runs synchronously during
		// construction, which is safe inside `blockConcurrencyWhile`.
		this.sql.exec(SCHEMA);
	}

	// ═════════════════════════════════════
	// YDocStorage implementation
	// ═════════════════════════════════════

	async getYDoc(): Promise<Doc> {
		const doc = new Doc();

		doc.transact(() => {
			// 1. Apply the compacted snapshot (if any)
			const snapshots = this.sql
				.exec<SnapshotRow>("SELECT data FROM yjs_snapshot WHERE id = 1")
				.toArray();

			if (snapshots.length > 0) {
				applyUpdate(doc, new Uint8Array(snapshots[0].data));
			}

			// 2. Apply all incremental updates in insertion order
			const updates = this.sql
				.exec<UpdateRow>("SELECT data FROM yjs_updates ORDER BY id ASC")
				.toArray();

			for (const row of updates) {
				applyUpdate(doc, new Uint8Array(row.data));
			}
		});

		return doc;
	}

	async storeUpdate(update: Uint8Array): Promise<void> {
		// Use a synchronous transaction so the INSERT + threshold
		// check + possible compaction are all atomic.
		this.storage.transactionSync(() => {
			// INSERT the new incremental update
			this.sql.exec(
				"INSERT INTO yjs_updates (data, byte_length) VALUES (?, ?)",
				update.buffer.byteLength !== update.byteLength
					? update.slice().buffer
					: update.buffer,
				update.byteLength,
			);

			// Check compaction thresholds via aggregate query
			const { total_count, total_bytes } = this.sql
				.exec<AggregateRow>(
					"SELECT COUNT(*) AS total_count, COALESCE(SUM(byte_length), 0) AS total_bytes FROM yjs_updates",
				)
				.one();

			if (total_count > this.maxUpdates || total_bytes > this.maxBytes) {
				this.compactSync();
			}
		});
	}

	async commit(doc: Doc): Promise<void> {
		this.storage.transactionSync(() => {
			this.writeSnapshot(encodeStateAsUpdate(doc));
			this.sql.exec("DELETE FROM yjs_updates");
		});
	}

	// ═════════════════════════════════════
	// Internal helpers
	// ═════════════════════════════════════

	/**
	 * Compact all incremental updates into the snapshot within the
	 * current synchronous transaction.
	 *
	 * Rebuilds the document from the existing snapshot + all updates,
	 * then replaces the snapshot and clears the updates table.
	 */
	private compactSync(): void {
		const doc = new Doc();

		doc.transact(() => {
			// Read existing snapshot
			const snapshots = this.sql
				.exec<SnapshotRow>("SELECT data FROM yjs_snapshot WHERE id = 1")
				.toArray();

			if (snapshots.length > 0) {
				applyUpdate(doc, new Uint8Array(snapshots[0].data));
			}

			// Apply all incremental updates
			const updates = this.sql
				.exec<UpdateRow>("SELECT data FROM yjs_updates ORDER BY id ASC")
				.toArray();

			for (const row of updates) {
				applyUpdate(doc, new Uint8Array(row.data));
			}
		});

		// Write the compacted state and clear updates
		this.writeSnapshot(encodeStateAsUpdate(doc));
		this.sql.exec("DELETE FROM yjs_updates");
	}

	/**
	 * Insert or replace the single-row snapshot.
	 */
	private writeSnapshot(data: Uint8Array): void {
		const buffer =
			data.buffer.byteLength !== data.byteLength
				? data.slice().buffer
				: data.buffer;

		this.sql.exec(
			"INSERT OR REPLACE INTO yjs_snapshot (id, data) VALUES (1, ?)",
			buffer,
		);
	}
}
