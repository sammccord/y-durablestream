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
	acceptWebSocket(ws: WebSocket, tags?: string[]): void;
	getWebSockets(tag?: string): WebSocket[];
	getTags(ws: WebSocket): string[];
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
	pipeThrough<T>(
		transform: { writable: WritableStream<R>; readable: ReadableStream<T> },
		options?: StreamPipeOptions,
	): ReadableStream<T>;
	pipeTo(destination: WritableStream<R>, options?: StreamPipeOptions): Promise<void>;
	tee(): [ReadableStream<R>, ReadableStream<R>];
	cancel(reason?: unknown): Promise<void>;
	readonly locked: boolean;
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

declare class WritableStream<W = unknown> {
	constructor(
		underlyingSink?: UnderlyingSink<W>,
		strategy?: QueuingStrategy<W>,
	);
	getWriter(): WritableStreamDefaultWriter<W>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
	readonly locked: boolean;
}

declare class WritableStreamDefaultWriter<W = unknown> {
	constructor(stream: WritableStream<W>);
	write(chunk: W): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
	releaseLock(): void;
	readonly closed: Promise<undefined>;
	readonly ready: Promise<undefined>;
	readonly desiredSize: number | null;
}

declare class TransformStream<I = unknown, O = unknown> {
	constructor(
		transformer?: Transformer<I, O>,
		writableStrategy?: QueuingStrategy<I>,
		readableStrategy?: QueuingStrategy<O>,
	);
	readonly readable: ReadableStream<O>;
	readonly writable: WritableStream<I>;
}

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

interface UnderlyingSink<W = unknown> {
	start?(controller: WritableStreamDefaultController): void | Promise<void>;
	write?(chunk: W, controller: WritableStreamDefaultController): void | Promise<void>;
	close?(controller: WritableStreamDefaultController): void | Promise<void>;
	abort?(reason?: unknown): void | Promise<void>;
	type?: undefined;
}

interface WritableStreamDefaultController {
	error(e?: unknown): void;
	readonly signal: AbortSignal;
}

interface Transformer<I = unknown, O = unknown> {
	start?(controller: TransformStreamDefaultController<O>): void | Promise<void>;
	transform?(chunk: I, controller: TransformStreamDefaultController<O>): void | Promise<void>;
	flush?(controller: TransformStreamDefaultController<O>): void | Promise<void>;
	readableType?: undefined;
	writableType?: undefined;
}

interface TransformStreamDefaultController<O = unknown> {
	enqueue(chunk: O): void;
	error(reason?: unknown): void;
	terminate(): void;
	readonly desiredSize: number | null;
}

interface StreamPipeOptions {
	preventClose?: boolean;
	preventAbort?: boolean;
	preventCancel?: boolean;
	signal?: AbortSignal;
}

interface QueuingStrategy<T = unknown> {
	highWaterMark?: number;
	size?(chunk: T): number;
}

// ═══════════════════════════════════════════════════════════
// Additional globals used by the source but not in "ESNext"
// ═══════════════════════════════════════════════════════════

declare class TextEncoder {
	encode(input?: string): Uint8Array;
	encodeInto(input: string, dest: Uint8Array): { read: number; written: number };
	readonly encoding: string;
}

declare class TextDecoder {
	constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
	decode(input?: ArrayBufferView | ArrayBuffer, options?: { stream?: boolean }): string;
	readonly encoding: string;
	readonly fatal: boolean;
	readonly ignoreBOM: boolean;
}
