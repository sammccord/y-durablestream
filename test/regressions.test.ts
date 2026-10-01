import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import { YStreamClient } from "../src/client";

import type { YStreamProviderStub } from "../src/types";
import type { TestProvider } from "./worker";

// ──────────────────────────────────────────────────────────
// Regression coverage for the 0.9.0 performance/billing fixes:
//
// 1. Dirty-flag commit gate — a read-only subscribe/close cycle (syncOnce)
//    must not trigger a full-snapshot compaction commit.
// 2. Cancelable reconnect backoff — disconnect() during the backoff sleep
//    resolves connect() promptly instead of after up to maxDelay.
// 3. notifyDebounceMs — a burst of updates is delivered to a registered
//    push-subscriber as one merged push, not one per update.
//
// And for the 0.9.1 stream fixes:
//
// 4. A subscriber keeps receiving updates after its own write's echo is
//    suppressed.
// 5. syncOnce() tears down only its own subscription, not a live connect()
//    stream sharing the clientId.
// 6. disconnect() while subscribe() is in flight still removes the
//    provider-side consumer.
// 7. disconnect() ends a live connect() promptly instead of waiting for the
//    provider's next frame.
// ──────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(25);
	}
}

function consumerCount(provider: DurableObjectStub<TestProvider>): Promise<number> {
	return runInDurableObject(provider, (instance) => instance["broadcast"].consumerCount);
}

function stubFor(
	provider: DurableObjectStub<TestProvider>,
	overrides: Partial<YStreamProviderStub> = {},
): YStreamProviderStub {
	return {
		subscribe: (...args) => provider.subscribe(...args),
		update: (...args) => provider.update(...args),
		getYDoc: () => provider.getYDoc(),
		register: (...args) => provider.register(...args),
		deregister: (...args) => provider.deregister(...args),
		unsubscribe: (...args) => provider.unsubscribe(...args),
		...overrides,
	};
}

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

describe("echo suppression does not stall the originator's stream", () => {
	it("delivers later updates to a subscriber after its own write", async () => {
		const provider = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName("echo-stall"));
		const sub = env.Y_STREAM_SUBSCRIBER.get(env.Y_STREAM_SUBSCRIBER.idFromName("echo-stall-sub"));
		await sub.connectToProvider("echo-stall");
		await waitFor(() => sub.getSynced());

		await sub.insertText("mine", 0, "a");
		await waitFor(async () => {
			const doc = new Doc();
			applyUpdate(doc, await provider.getYDoc());
			return doc.getText("mine").toString() === "a";
		});

		await provider.applyUpdate(createTextUpdate("theirs", "p"));
		await waitFor(async () => (await sub.getText("theirs")) === "p");
		expect(await sub.getText("theirs")).toBe("p");
		await sub.disconnect();
	});
});

describe("disconnect() during a live stream", () => {
	it("resolves connect() without waiting for another frame", async () => {
		const provider = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName("live-disconnect"));
		const client = new YStreamClient(new Doc(), { stub: stubFor(provider) });
		const connected = client.connect();
		await waitFor(() => client.synced);

		client.disconnect();
		const outcome = await Promise.race([connected.then(() => "resolved"), delay(1_000).then(() => "hung")]);

		expect(outcome).toBe("resolved");
		expect(client.status).toBe("disconnected");
		await waitFor(async () => (await consumerCount(provider)) === 0);
	});
});

describe("per-subscription teardown", () => {
	it("syncOnce() leaves a live connect() stream with the same clientId intact", async () => {
		const provider = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName("sub-scope"));
		const doc = new Doc();
		const client = new YStreamClient(doc, {
			stub: stubFor(provider),
			clientId: "shared",
		});
		const connected = client.connect();
		await waitFor(() => client.synced);

		await client.syncOnce();
		await provider.applyUpdate(createTextUpdate("after", "x"));
		await waitFor(() => doc.getText("after").toString() === "x");

		expect(doc.getText("after").toString()).toBe("x");
		expect(client.status).toBe("synced");
		client.disconnect();
		await connected;
		await waitFor(async () => (await consumerCount(provider)) === 0);
	});

	it("disconnect() during subscribe() removes the provider-side consumer", async () => {
		const provider = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName("sub-race"));
		let client: YStreamClient;
		const stub = stubFor(provider, {
			subscribe: async (...args) => {
				const stream = await provider.subscribe(...args);
				client.disconnect();
				return stream;
			},
		});
		client = new YStreamClient(new Doc(), { stub });

		await client.connect();
		await waitFor(async () => (await consumerCount(provider)) === 0);

		expect(client.status).toBe("disconnected");
		expect(await consumerCount(provider)).toBe(0);
	});
});

describe("client error reporting", () => {
	it("reports an undecodable frame through onError", async () => {
		const provider = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName("oversized-frame"));
		await provider.applyUpdate(createTextUpdate("root", "more than sixteen bytes of content"));
		const errors: unknown[] = [];
		const client = new YStreamClient(new Doc(), {
			stub: stubFor(provider),
			maxFrameSize: 16,
			onError: (error) => errors.push(error),
		});

		await client.connect();

		expect(errors).toContainEqual(expect.objectContaining({ name: "FrameDecodeError" }));
		await waitFor(async () => (await consumerCount(provider)) === 0);
	});

	it("reports a failed subscribe through onError", async () => {
		const provider = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName("failed-subscribe"));
		const errors: unknown[] = [];
		const client = new YStreamClient(new Doc(), {
			stub: stubFor(provider, {
				subscribe: async () => {
					throw new Error("provider unavailable");
				},
			}),
			onError: (error) => errors.push(error),
		});

		await client.connect();

		expect(errors.map(String)).toEqual(["Error: provider unavailable"]);
	});

	it("syncOnce() resolves true on success and false on failure", async () => {
		const provider = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName("sync-once-result"));
		const ok = new YStreamClient(new Doc(), { stub: stubFor(provider) });
		const failing = new YStreamClient(new Doc(), {
			stub: stubFor(provider, {
				subscribe: async () => {
					throw new Error("provider unavailable");
				},
			}),
			onError: () => {},
		});

		expect(await ok.syncOnce()).toBe(true);
		expect(await failing.syncOnce()).toBe(false);
		await waitFor(async () => (await consumerCount(provider)) === 0);
	});
});

describe("client lifecycle", () => {
	function failingClient(name: string, reconnect: { maxRetries: number } | false) {
		const provider = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName(name));
		const calls = { subscribes: 0 };
		const client = new YStreamClient(new Doc(), {
			stub: stubFor(provider, {
				subscribe: async () => {
					calls.subscribes++;
					throw new Error("provider unavailable");
				},
			}),
			reconnect: reconnect && { ...reconnect, initialDelay: 20 },
			onError: () => {},
		});
		return { client, calls };
	}

	it("emits 'disconnected' once, after the reconnect loop has ended", async () => {
		const { client, calls } = failingClient("disconnected-once", { maxRetries: 2 });
		const seenAt: number[] = [];
		client.onStatusChange((status) => {
			if (status === "disconnected") seenAt.push(calls.subscribes);
		});

		await client.connect();
		await delay(100);

		expect(calls.subscribes).toBe(3);
		expect(seenAt).toEqual([3]);
	});

	it("connect() from a 'disconnected' listener starts a fresh loop after the first ends", async () => {
		const { client, calls } = failingClient("listener-reconnect", { maxRetries: 1 });
		const seenAt: number[] = [];
		let second: Promise<void> | undefined;
		client.onStatusChange((status) => {
			if (status !== "disconnected") return;
			seenAt.push(calls.subscribes);
			second ??= client.connect();
		});

		await client.connect();
		await second;

		expect(seenAt).toEqual([2, 4]);
		expect(client.status).toBe("disconnected");
	});

	it("connect() from a 'disconnected' listener reconnects when auto-reconnect is off", async () => {
		const { client, calls } = failingClient("manual-reconnect", false);
		let second: Promise<void> | undefined;
		client.onStatusChange((status) => {
			if (status === "disconnected") second ??= client.connect();
		});

		await client.connect();
		await second;

		expect(calls.subscribes).toBe(2);
	});
});

describe("interest divergence guard", () => {
	it("reports through onError when a filtered stream leaves updates pending", async () => {
		const provider = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName("interest-gap"));
		const errors: unknown[] = [];
		const readerDoc = new Doc();
		const reader = new YStreamClient(readerDoc, {
			stub: stubFor(provider),
			interest: ["b"],
			onError: (error) => errors.push(error),
		});
		const writerDoc = new Doc();
		const writer = new YStreamClient(writerDoc, { stub: stubFor(provider) });
		const readerLoop = reader.connect();
		const writerLoop = writer.connect();
		await waitFor(() => reader.synced && writer.synced);

		writerDoc.transact(() => writerDoc.getMap("a").set("x", 1), { key: "a" });
		writerDoc.transact(() => writerDoc.getMap("b").set("y", 2), { key: "b" });
		await waitFor(() => errors.length > 0);

		expect(errors).toEqual([expect.objectContaining({ name: "PendingUpdateError" })]);
		reader.disconnect();
		writer.disconnect();
		await Promise.all([readerLoop, writerLoop]);
		await waitFor(async () => (await consumerCount(provider)) === 0);
	});
});
