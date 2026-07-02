/**
 * Minimal type shims for the `cloudflare:workers` virtual module and
 * related Cloudflare Durable Object / Web Streams APIs.
 *
 * These declarations allow `tsup` to generate `.d.ts` output without
 * depending on `@cloudflare/workers-types` (which can cause type
 * collisions with `wrangler types`-generated declarations).
 *
 * At runtime, the real Cloudflare Workers environment provides these
 * types.  Consumers of the published package will have their own
 * full type definitions from `wrangler types`.
 *
 * @internal Not part of the public API — used only during the build.
 */

// ═══════════════════════════════════════════════════════════
// cloudflare:workers module
// ═══════════════════════════════════════════════════════════

declare module "cloudflare:workers" {
	export abstract class DurableObject<Env = unknown> {
		protected ctx: DurableObjectState;
		protected env: Env;
		constructor(ctx: DurableObjectState, env: Env);
	}
}

// ═══════════════════════════════════════════════════════════
// Durable Object types (global scope)
// ═══════════════════════════════════════════════════════════

interface DurableObjectState {
	readonly id: DurableObjectId;
	readonly storage: DurableObjectStorage;
	waitUntil(promise: Promise<unknown>): void;
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
	abort(reason?: string): void;
}

interface DurableObjectId {
	toString(): string;
	equals(other: DurableObjectId): boolean;
	readonly name?: string;
}

interface DurableObjectStorage {
	get<T = unknown>(key: string, options?: DurableObjectGetOptions): Promise<T | undefined>;
	get<T = unknown>(keys: string[], options?: DurableObjectGetOptions): Promise<Map<string, T>>;
	list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
	put<T>(key: string, value: T, options?: DurableObjectPutOptions): Promise<void>;
	put<T>(entries: Record<string, T>, options?: DurableObjectPutOptions): Promise<void>;
	delete(key: string, options?: DurableObjectPutOptions): Promise<boolean>;
	delete(keys: string[], options?: DurableObjectPutOptions): Promise<number>;
	deleteAll(options?: DurableObjectPutOptions): Promise<void>;
	transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;
	transactionSync<T>(closure: () => T): T;
	sync(): Promise<void>;
	readonly sql: SqlStorage;
}

interface DurableObjectTransaction {
	get<T = unknown>(key: string, options?: DurableObjectGetOptions): Promise<T | undefined>;
	get<T = unknown>(keys: string[], options?: DurableObjectGetOptions): Promise<Map<string, T>>;
	list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
	put<T>(key: string, value: T, options?: DurableObjectPutOptions): Promise<void>;
	put<T>(entries: Record<string, T>, options?: DurableObjectPutOptions): Promise<void>;
	delete(key: string, options?: DurableObjectPutOptions): Promise<boolean>;
	delete(keys: string[], options?: DurableObjectPutOptions): Promise<number>;
	rollback(): void;
}

interface DurableObjectListOptions {
	start?: string;
	startAfter?: string;
	end?: string;
	prefix?: string;
	reverse?: boolean;
	limit?: number;
	allowConcurrency?: boolean;
	noCache?: boolean;
}

interface DurableObjectGetOptions {
	allowConcurrency?: boolean;
	noCache?: boolean;
}

interface DurableObjectPutOptions {
	allowConcurrency?: boolean;
	allowUnconfirmed?: boolean;
	noCache?: boolean;
}

interface SqlStorage {
	exec<T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): SqlStorageCursor<T>;
	readonly databaseSize: number;
}

type SqlStorageValue = ArrayBuffer | string | number | null;

interface SqlStorageCursor<T extends Record<string, SqlStorageValue>> {
	next(): { done?: false; value: T } | { done: true; value?: never };
	toArray(): T[];
	one(): T;
	raw<U extends SqlStorageValue[]>(): IterableIterator<U>;
	readonly columnNames: string[];
	readonly rowsRead: number;
	readonly rowsWritten: number;
	[Symbol.iterator](): IterableIterator<T>;
}

// ═══════════════════════════════════════════════════════════
// Web Streams API (subset used by y-durablestream)
//
// These are standard Web APIs available in the CF Workers
// runtime but not included in TypeScript's "ESNext" lib.
// ═══════════════════════════════════════════════════════════

declare class ReadableStream<R = unknown> {
	constructor(
		underlyingSource?: UnderlyingSource<R>,
		strategy?: QueuingStrategy<R>,
	);
	getReader(): ReadableStreamDefaultReader<R>;
	cancel(reason?: unknown): Promise<void>;
	readonly locked: boolean;

	/** Async iteration support (available in workerd runtime). */
	[Symbol.asyncIterator](): AsyncIterableIterator<R>;
}

declare class ReadableStreamDefaultReader<R = unknown> {
	constructor(stream: ReadableStream<R>);
	read(): Promise<ReadableStreamReadResult<R>>;
	cancel(reason?: unknown): Promise<void>;
	releaseLock(): void;
	readonly closed: Promise<undefined>;
}

type ReadableStreamReadResult<T> =
	| { done: false; value: T }
	| { done: true; value?: undefined };

interface UnderlyingSource<R = unknown> {
	start?(controller: ReadableStreamDefaultController<R>): void | Promise<void>;
	pull?(controller: ReadableStreamDefaultController<R>): void | Promise<void>;
	cancel?(reason?: unknown): void | Promise<void>;
	type?: undefined;
}

interface ReadableStreamDefaultController<R = unknown> {
	enqueue(chunk: R): void;
	close(): void;
	error(e?: unknown): void;
	readonly desiredSize: number | null;
}

interface QueuingStrategy<T = unknown> {
	highWaterMark?: number;
	size?(chunk: T): number;
}
