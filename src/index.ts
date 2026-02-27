/**
 * # y-durablestream
 *
 * Yjs document synchronization between Cloudflare Durable Objects via
 * a shared broadcast buffer and pull-based `ReadableStream`.
 *
 * This package provides two core primitives:
 *
 * - **{@link YStreamProvider}** — A Durable Object that hosts an
 *   authoritative Yjs document and streams updates to subscribers via
 *   `ReadableStream`.  Uses an internal broadcast buffer with
 *   configurable {@link BackpressurePolicy} so slow subscribers are
 *   handled explicitly rather than silently failing.
 *
 * - **{@link YStreamClient}** — A client that synchronises a local
 *   `Y.Doc` with an upstream provider, sending local changes back via
 *   direct RPC calls.  Supports optional automatic reconnection with
 *   exponential backoff.
 *
 * Two pluggable storage backends are included:
 *
 * - **{@link DurableObjectKvStorage}** — Async KV API (default).
 * - **{@link DurableObjectSqlStorage}** — Synchronous SQLite API
 *   (cheaper, atomic transactions).
 *
 * Implement the {@link YDocStorage} interface to provide a custom
 * persistence layer.
 *
 * @example
 * ```ts
 * // Provider — extend and deploy as a Durable Object
 * import { YStreamProvider } from "y-durablestream";
 * export class DocProvider extends YStreamProvider<Env> {
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env, { backpressure: "drop-oldest", streamHighWaterMark: 128 });
 *   }
 * }
 *
 * // Subscriber — connect from any other Durable Object
 * import { YStreamClient } from "y-durablestream";
 * import { Doc } from "yjs";
 *
 * const doc = new Doc();
 * const client = new YStreamClient(doc, {
 *   stub,
 *   reconnect: { maxRetries: 10, initialDelay: 200 },
 * });
 * ctx.waitUntil(client.connect());
 * ```
 *
 * @packageDocumentation
 */

export { YStreamProvider } from "./provider";
export { YStreamClient } from "./client";
export { encodeFrame, encodeFrames, createFrameDecoder, FrameDecodeError } from "./protocol";
export type { FrameDecoder } from "./protocol";
export {
	DurableObjectKvStorage,
	DurableObjectSqlStorage,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_UPDATES,
} from "./storage";
export type { YDocStorage, YDocStorageOptions } from "./storage";
export type {
	BackpressurePolicy,
	ReconnectOptions,
	YStreamProviderStub,
	YStreamClientOptions,
	YStreamClientStatus,
	YStreamProviderOptions,
	StatusChangeHandler,
} from "./types";
