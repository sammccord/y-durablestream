/**
 * # y-durablestream
 *
 * Yjs document synchronization between Cloudflare Durable Objects via
 * `TransformStream`.
 *
 * This package provides two core primitives:
 *
 * - **{@link YStreamProvider}** — A Durable Object that hosts an
 *   authoritative Yjs document and streams updates to subscribers via
 *   `ReadableStream`.
 *
 * - **{@link YStreamClient}** — A client that synchronises a local
 *   `Y.Doc` with an upstream provider, sending local changes back via
 *   direct RPC calls.
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
 * export class DocProvider extends YStreamProvider<Env> {}
 *
 * // Subscriber — connect from any other Durable Object
 * import { YStreamClient } from "y-durablestream";
 * import { Doc } from "yjs";
 *
 * const doc = new Doc();
 * const client = new YStreamClient(doc, { stub });
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
	YStreamProviderStub,
	YStreamClientOptions,
	YStreamClientStatus,
	YStreamProviderOptions,
	StatusChangeHandler,
	StreamSession,
} from "./types";
