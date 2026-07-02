import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Doc, encodeStateAsUpdate } from "yjs";

import { YStreamClient } from "../src/client";

import type { YStreamProviderStub } from "../src/types";

// ──────────────────────────────────────────────────────────
// Regression coverage for the 0.9.0 performance/billing fixes:
//
// 1. Dirty-flag commit gate — a read-only subscribe/close cycle (syncOnce)
//    must not trigger a full-snapshot compaction commit.
// 2. Cancelable reconnect backoff — disconnect() during the backoff sleep
//    resolves connect() promptly instead of after up to maxDelay.
// 3. notifyDebounceMs — a burst of updates is delivered to a registered
//    push-subscriber as one merged push, not one per update.
// ──────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A Yjs state update inserting text at position 0 in a named Y.Text field. */
function createTextUpdate(field: string, content: string): Uint8Array {
	const doc = new Doc();
	doc.getText(field).insert(0, content);
	return encodeStateAsUpdate(doc);
}

describe("commit dirty-flag gate", () => {
	it("skips the last-consumer commit when nothing was written", async () => {
		const provider = env.Y_COMMIT_PROVIDER.get(
			env.Y_COMMIT_PROVIDER.idFromName("cc-skip"),
		);
		const client = new YStreamClient(new Doc(), {
			stub: provider as unknown as YStreamProviderStub,
		});

		// Consumer teardown crosses the RPC boundary asynchronously, so poll
		// until the expected count settles rather than sleeping a fixed time.
		const waitForCommitCount = async (expected: number) => {
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline) {
				if ((await provider.getCommitCount()) === expected) break;
				await delay(50);
			}
			expect(await provider.getCommitCount()).toBe(expected);
		};

		// Two read-only one-shot syncs; each ends with the last consumer
		// leaving. Neither must pay a compaction commit.
		await client.syncOnce();
		await client.syncOnce();
		await delay(300); // give an erroneous commit time to land
		expect(await provider.getCommitCount()).toBe(0);

		// A real write makes the doc dirty — the next last-consumer-gone
		// event commits exactly once...
		await provider.applyUpdate(createTextUpdate("root", "x"));
		await client.syncOnce();
		await waitForCommitCount(1);

		// ...and a subsequent read-only cycle skips again.
		await client.syncOnce();
		await delay(300);
		expect(await provider.getCommitCount()).toBe(1);
	});
});

describe("reconnect backoff cancellation", () => {
	it("disconnect() during the backoff sleep resolves connect() promptly", async () => {
		// A stub whose subscribe always fails, forcing the client straight
		// into the reconnect loop's backoff sleep.
		const stub: YStreamProviderStub = {
			subscribe: async () => {
				throw new Error("provider unavailable");
			},
			update: async () => {},
			getYDoc: async () => new Uint8Array(),
			register: async () => {},
			deregister: async () => {},
		};

		const client = new YStreamClient(new Doc(), {
			stub,
			// A backoff long enough that a leaked timer would dominate the
			// test timeout if disconnect() failed to wake the sleep.
			reconnect: { initialDelay: 30_000, maxRetries: 5 },
		});

		const started = Date.now();
		const connected = client.connect();
		await delay(50); // let the first attempt fail and enter backoff
		expect(client.status).toBe("reconnecting");

		client.disconnect();
		await connected;

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(client.status).toBe("disconnected");
	});
});

describe("notify-push coalescing (notifyDebounceMs)", () => {
	it("delivers a burst of updates as one merged push", async () => {
		const provider = env.Y_DEBOUNCE_PROVIDER.get(
			env.Y_DEBOUNCE_PROVIDER.idFromName("dp-burst"),
		);
		const receiver = env.Y_NOTIFY_RECEIVER.get(
			env.Y_NOTIFY_RECEIVER.idFromName("recv-debounce"),
		);
		await provider.register("recv-debounce", { name: "recv-debounce" });

		// Burst of 5 updates inside the provider's 50 ms window.
		for (let i = 0; i < 5; i++) {
			await provider.applyUpdate(createTextUpdate(`field${i}`, "x"));
		}

		// Wait for the flush (50 ms window) plus delivery.
		const deadline = Date.now() + 3_000;
		while (Date.now() < deadline) {
			if ((await receiver.getText("field4")) === "x") break;
			await delay(25);
		}

		// All content arrived...
		for (let i = 0; i < 5; i++) {
			expect(await receiver.getText(`field${i}`)).toBe("x");
		}
		// ...in far fewer pushes than updates (1 expected; allow 2 in case
		// the burst straddles a window boundary).
		expect(await receiver.getPushCount()).toBeLessThanOrEqual(2);
	});
});
