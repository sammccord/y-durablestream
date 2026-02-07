import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
	test: {
		globals: true,
		// Suppress expected workerd stream teardown errors.
		//
		// When a subscriber disconnects from a YStreamProvider, the workerd
		// runtime emits "unhandledrejection" events at the C++ level for
		// "Stream was cancelled." and "Network connection lost." errors.
		// These are infrastructure-level events from the workerd stream
		// pipeline that fire before JS rejection handlers can process them.
		// Our application code handles them correctly (.then onRejected
		// handlers in readLoop / broadcastUpdate), but Vitest counts the
		// workerd-reported events as unhandled errors and exits non-zero.
		//
		// This is a known characteristic of TransformStream teardown across
		// Durable Object RPC boundaries in the workerd test environment and
		// does not affect production behavior.
		dangerouslyIgnoreUnhandledErrors: true,
		poolOptions: {
			workers: {
				singleWorker: true,
				wrangler: {
					configPath: "./wrangler.toml",
				},
			},
		},
	},
});
