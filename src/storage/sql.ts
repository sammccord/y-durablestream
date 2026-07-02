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

// Plain INTEGER PRIMARY KEY (rowid alias), not AUTOINCREMENT: monotonic ids are
// only needed between compactions (the table is emptied by every compaction),
// and AUTOINCREMENT costs an extra `sqlite_sequence` bookkeeping row write per
// insert. Existing tables created with AUTOINCREMENT keep working unchanged.
const SCHEMA = `
	CREATE TABLE IF NOT EXISTS yjs_snapshot (
		id          INTEGER PRIMARY KEY CHECK (id = 1),
		data        BLOB NOT NULL
	);

	CREATE TABLE IF NOT EXISTS yjs_updates (
		id          INTEGER PRIMARY KEY,
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

	/**
	 * Running compaction-threshold counters, maintained in memory instead of
	 * re-aggregating the whole `yjs_updates` table on every write. Safe because
	 * a Durable Object's SQLite storage is exclusive to this instance and all
	 * writes go through this class. Seeded once from the table at construction.
	 */
	private updateCount: number;
	private updateBytes: number;

	constructor(storage: SqlCapableStorage, options?: YDocStorageOptions) {
		this.storage = storage;
		this.sql = storage.sql;
		this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxUpdates = options?.maxUpdates ?? DEFAULT_MAX_UPDATES;

		// Ensure tables exist.  This runs synchronously during
		// construction, which is safe inside `blockConcurrencyWhile`.
		this.sql.exec(SCHEMA);

		// Seed the running counters (one aggregate scan per DO construction,
		// instead of one per stored update).
		const seeded = this.readAggregates();
		this.updateCount = seeded.count;
		this.updateBytes = seeded.bytes;
	}

	/** Aggregate the updates table — used to seed/reseed the running counters. */
	private readAggregates(): { count: number; bytes: number } {
		const { total_count, total_bytes } = this.sql
			.exec<AggregateRow>(
				"SELECT COUNT(*) AS total_count, COALESCE(SUM(byte_length), 0) AS total_bytes FROM yjs_updates",
			)
			.one();
		return { count: total_count, bytes: total_bytes };
	}

	/**
	 * Re-derive the counters from the table after a failed transaction — a
	 * rollback restores the rows but not the in-memory increments.
	 */
	private reseedCounters(): void {
		const { count, bytes } = this.readAggregates();
		this.updateCount = count;
		this.updateBytes = bytes;
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
		try {
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
				this.updateCount += 1;
				this.updateBytes += update.byteLength;

				if (this.updateCount > this.maxUpdates || this.updateBytes > this.maxBytes) {
					this.compactSync();
				}
			});
		} catch (error) {
			this.reseedCounters();
			throw error;
		}
	}

	async commit(doc: Doc): Promise<void> {
		try {
			this.storage.transactionSync(() => {
				this.writeSnapshot(encodeStateAsUpdate(doc));
				this.clearUpdates();
			});
		} catch (error) {
			this.reseedCounters();
			throw error;
		}
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
		this.clearUpdates();
	}

	/** Empty the updates table and reset the running threshold counters. */
	private clearUpdates(): void {
		this.sql.exec("DELETE FROM yjs_updates");
		this.updateCount = 0;
		this.updateBytes = 0;
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
