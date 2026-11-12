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

	CREATE TABLE IF NOT EXISTS yjs_snapshot_chunks (
		idx         INTEGER PRIMARY KEY,
		data        BLOB NOT NULL
	);

	CREATE TABLE IF NOT EXISTS yjs_updates (
		id          INTEGER PRIMARY KEY,
		data        BLOB NOT NULL,
		byte_length INTEGER NOT NULL
	);
`;

/**
 * Largest BLOB written to a single row. SQLite-backed Durable Objects cap a
 * row at 2 MB; snapshots and updates beyond this are split or folded into
 * the (chunked) snapshot.
 */
const MAX_BLOB_BYTES = 1024 * 1024;

/** A standalone `ArrayBuffer` holding exactly the bytes of `data`. */
function toArrayBuffer(data: Uint8Array): ArrayBufferLike {
	return data.buffer.byteLength !== data.byteLength ? data.slice().buffer : data.buffer;
}

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
	snapshot_bytes: number;
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
 * |                  | document snapshot (its first 1 MB).     |
 * | `yjs_snapshot_chunks` | The rest of a snapshot larger than |
 * |                  | 1 MB, in 1 MB rows ordered by `idx`.    |
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
	private readonly snapshotGrowthRatio: number;
	private readonly sql: SqlStorageLike;
	private readonly storage: SqlCapableStorage;

	/**
	 * Running compaction-threshold counters, maintained in memory instead of
	 * re-aggregating the tables on every write. Safe because a Durable
	 * Object's SQLite storage is exclusive to this instance and all writes go
	 * through this class. Seeded once from the tables at construction.
	 */
	private updateCount = 0;
	private updateBytes = 0;
	private snapshotBytes = 0;

	constructor(storage: SqlCapableStorage, options?: YDocStorageOptions) {
		this.storage = storage;
		this.sql = storage.sql;
		this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxUpdates = options?.maxUpdates ?? DEFAULT_MAX_UPDATES;
		this.snapshotGrowthRatio = options?.snapshotGrowthRatio ?? DEFAULT_SNAPSHOT_GROWTH_RATIO;

		// Ensure tables exist.  This runs synchronously during
		// construction, which is safe inside `blockConcurrencyWhile`.
		this.sql.exec(SCHEMA);

		// One aggregate scan per DO construction, instead of one per stored update.
		this.seedCounters();
	}

	/**
	 * Derive the counters from the tables — at construction, and again after
	 * a failed transaction, whose rollback restores the rows but not the
	 * in-memory changes.
	 */
	private seedCounters(): void {
		const row = this.sql
			.exec<AggregateRow>(
				`SELECT
					(SELECT COUNT(*) FROM yjs_updates) AS total_count,
					(SELECT COALESCE(SUM(byte_length), 0) FROM yjs_updates) AS total_bytes,
					(SELECT COALESCE(SUM(LENGTH(data)), 0) FROM yjs_snapshot)
						+ (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM yjs_snapshot_chunks) AS snapshot_bytes`,
			)
			.one();
		this.updateCount = row.total_count;
		this.updateBytes = row.total_bytes;
		this.snapshotBytes = row.snapshot_bytes;
	}

	// ═════════════════════════════════════
	// YDocStorage implementation
	// ═════════════════════════════════════

	async getYDoc(): Promise<Doc> {
		const doc = createCarrierDoc();
		this.applyStoredState(doc);
		return doc;
	}

	async loadInto(doc: Doc): Promise<void> {
		this.applyStoredState(doc);
	}

	async storeUpdate(update: Uint8Array, doc?: Doc): Promise<void> {
		try {
			// Use a synchronous transaction so the INSERT + threshold
			// check + possible compaction are all atomic.
			this.storage.transactionSync(() => {
				const fitsInRow = update.byteLength <= MAX_BLOB_BYTES;
				if (fitsInRow) {
					this.sql.exec(
						"INSERT INTO yjs_updates (data, byte_length) VALUES (?, ?)",
						toArrayBuffer(update),
						update.byteLength,
					);
					this.updateCount += 1;
					this.updateBytes += update.byteLength;
				}

				const byteLimit = Math.max(
					this.maxBytes,
					this.snapshotBytes * this.snapshotGrowthRatio,
				);
				if (
					fitsInRow &&
					this.updateCount <= this.maxUpdates &&
					this.updateBytes <= byteLimit
				) {
					return;
				}

				// Compact. The live doc, when given, already holds this update;
				// otherwise rebuild the state from the tables (plus the update
				// itself when it was too large to insert).
				let source = doc;
				if (!source) {
					source = createCarrierDoc();
					this.applyStoredState(source);
					if (!fitsInRow) applyUpdate(source, update);
				}
				this.writeSnapshot(encodeStateAsUpdate(source));
				this.clearUpdates();
			});
		} catch (error) {
			this.seedCounters();
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
			this.seedCounters();
			throw error;
		}
	}

	// ═════════════════════════════════════
	// Internal helpers
	// ═════════════════════════════════════

	/** Apply the stored snapshot plus all incremental updates to `doc`. */
	private applyStoredState(doc: Doc): void {
		doc.transact(() => {
			const snapshot = this.readSnapshot();
			if (snapshot) {
				applyUpdate(doc, snapshot);
			}

			const updates = this.sql
				.exec<UpdateRow>("SELECT data FROM yjs_updates ORDER BY id ASC")
				.toArray();

			for (const row of updates) {
				applyUpdate(doc, new Uint8Array(row.data));
			}
		});
	}

	/** Read the snapshot, reassembling it from its chunks. */
	private readSnapshot(): Uint8Array | undefined {
		const first = this.sql
			.exec<SnapshotRow>("SELECT data FROM yjs_snapshot WHERE id = 1")
			.toArray();
		if (first.length === 0) return undefined;

		const rest = this.sql
			.exec<SnapshotRow>("SELECT data FROM yjs_snapshot_chunks ORDER BY idx ASC")
			.toArray();
		return joinChunks([first[0], ...rest].map((row) => new Uint8Array(row.data)));
	}

	/** Empty the updates table and reset the running threshold counters. */
	private clearUpdates(): void {
		this.sql.exec("DELETE FROM yjs_updates");
		this.updateCount = 0;
		this.updateBytes = 0;
	}

	/**
	 * Replace the snapshot. The first chunk stays in the single-row
	 * `yjs_snapshot` table (the whole snapshot when it fits, matching the
	 * pre-chunking layout); any remainder goes to `yjs_snapshot_chunks`.
	 */
	private writeSnapshot(data: Uint8Array): void {
		const chunks = splitIntoChunks(data, MAX_BLOB_BYTES);
		this.snapshotBytes = data.byteLength;
		this.sql.exec("DELETE FROM yjs_snapshot_chunks");
		for (const [index, chunk] of chunks.entries()) {
			if (index === 0) {
				this.sql.exec(
					"INSERT OR REPLACE INTO yjs_snapshot (id, data) VALUES (1, ?)",
					toArrayBuffer(chunk),
				);
			} else {
				this.sql.exec(
					"INSERT INTO yjs_snapshot_chunks (idx, data) VALUES (?, ?)",
					index,
					toArrayBuffer(chunk),
				);
			}
		}
	}
}
