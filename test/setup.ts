/**
 * Test setup file that suppresses expected workerd stream teardown errors.
 *
 * When a subscriber disconnects, the workerd runtime emits
 * `unhandledrejection` events at the C++ level for:
 *
 * - **"Stream was cancelled."** — fired when `reader.cancel()` tears
 *   down the `ReadableStream` bridging two Durable Objects.
 * - **"Network connection lost."** — fired when the provider's
 *   `WritableStreamDefaultWriter` attempts to write to a stream whose
 *   remote end has disconnected.
 *
 * These are infrastructure-level events from the workerd stream
 * pipeline, not application-level bugs.  Our JS code handles them
 * correctly (`.then(_, onRejected)` in readLoop / broadcastUpdate),
 * but workerd fires its own rejection event *before* the JS handler
 * executes.  Without this setup file, Vitest reports them as
 * "unhandled errors" and exits with a non-zero code.
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/handlers/unhandled-rejections/
 */
addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
	const message =
		event.reason instanceof Error
			? event.reason.message
			: String(event.reason ?? "");

	if (
		message.includes("Stream was cancelled") ||
		message.includes("Network connection lost")
	) {
		event.preventDefault();
	}
});
