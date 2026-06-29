/**
 * Ambient type shims for the Cloudflare Worker globals used **only** by
 * the test harness (`test/worker.ts`, `test/setup.ts`).
 *
 * The library deliberately avoids depending on `@cloudflare/workers-types`
 * (see {@link file://../src/cloudflare-shims.d.ts}); the test suite needs a
 * few extra globals that the build shims don't declare.  Keeping them in a
 * test-only ambient file lets `npm run typecheck` (which compiles `src` +
 * `test`) pass without pulling the full worker types into the build.
 *
 * At runtime the real workerd environment provides all of these.
 */

/**
 * A stub exposing the target Durable Object's RPC surface.  All Durable
 * Object methods are already async, so the stub is structurally the class
 * itself — sufficient for typechecking the tests.
 */
type DurableObjectStub<T = unknown> = T;

interface DurableObjectNamespace<T = unknown> {
	idFromName(name: string): DurableObjectId;
	idFromString(id: string): DurableObjectId;
	newUniqueId(options?: { jurisdiction?: string }): DurableObjectId;
	get(id: DurableObjectId): DurableObjectStub<T>;
	getByName(name: string): DurableObjectStub<T>;
}

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}

interface ExportedHandler<Env = unknown> {
	fetch?(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Response | Promise<Response>;
}

interface PromiseRejectionEvent {
	readonly promise: Promise<unknown>;
	readonly reason: unknown;
	preventDefault(): void;
}

declare function addEventListener(
	type: "unhandledrejection",
	handler: (event: PromiseRejectionEvent) => void,
): void;
