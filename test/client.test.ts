import { describe, expect, it } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import { BroadcastBuffer } from "../src/broadcast";
import { YStreamClient } from "../src/client";
import { DEFAULT_MAX_FRAME_SIZE, encodeFrame } from "../src/protocol";
import { encodeInitialSync } from "../src/sync";

import type { YStreamClientStatus, YStreamProviderStub } from "../src/types";

// ──────────────────────────────────────────────────────────
// YStreamClient against in-process stubs:
//
// 1. Connect performs no extra SyncStep1 round-trip (it re-sent the whole
//    document and bypassed interest scoping).
// 2. Initial sync is a diff against the client's state vector.
// 3. Decode and subscribe failures reach onError instead of vanishing.
// 4. Status never reports "disconnected" between reconnect attempts.
// 5. syncOnce reports whether it completed.
// ──────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function docWithText(field: string, content: string): Doc {
	const doc = new Doc();
	doc.getText(field).insert(0, content);
	return doc;
}

/**
 * A provider stub over a real BroadcastBuffer and the provider's own
 * initial-burst builder, recording every `update` RPC payload.
 */
function inProcessProvider(doc: Doc) {
	const broadcast = new BroadcastBuffer();
	const updates: Uint8Array[] = [];
	const subscribeArgs: (Uint8Array | undefined)[] = [];
	const burstBytes: number[] = [];
	const stub: YStreamProviderStub = {
		subscribe: async (clientId, interest, subscriptionId, stateVector) => {
			subscribeArgs.push(stateVector);
			const frames = encodeInitialSync(doc, DEFAULT_MAX_FRAME_SIZE, stateVector);
			burstBytes.push(frames.reduce((total, frame) => total + frame.byteLength, 0));
			return broadcast.createConsumer(
				frames,
				clientId,
				interest,
				subscriptionId,
			).readable;
		},
		update: async (data) => {
			updates.push(data);
		},
		getYDoc: async () => encodeStateAsUpdate(doc),
		register: async () => {},
		deregister: async () => {},
		unsubscribe: async (clientId, subscriptionId) => {
			broadcast.removeByClientId(clientId, subscriptionId);
		},
	};
	return { stub, updates, subscribeArgs, burstBytes };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !check()) await delay(10);
}

describe("YStreamClient connect handshake", () => {
	it("sends no update RPC when the client has nothing the provider lacks", async () => {
		const provider = inProcessProvider(docWithText("t", "provider"));
		const local = new Doc();
		const client = new YStreamClient(local, { stub: provider.stub });
		const connected = client.connect();
		await waitFor(() => client.synced);

		expect(local.getText("t").toString()).toBe("provider");
		expect(provider.updates).toEqual([]);

		client.disconnect();
		await connected;
	});

	it("still pushes local-only state to the provider", async () => {
		const provider = inProcessProvider(new Doc());
		const local = docWithText("mine", "local");
		const client = new YStreamClient(local, { stub: provider.stub });
		const connected = client.connect();
		await waitFor(() => provider.updates.length > 0);

		expect(provider.updates.length).toBe(1);

		client.disconnect();
		await connected;
	});

	it("receives only the diff against its state vector", async () => {
		const shared = docWithText("t", "x".repeat(50_000));
		const local = new Doc();
		applyUpdate(local, encodeStateAsUpdate(shared));
		shared.getText("t").insert(0, "new");

		const provider = inProcessProvider(shared);
		const client = new YStreamClient(local, { stub: provider.stub });
		expect(await client.syncOnce()).toBe(true);

		expect(provider.subscribeArgs[0]).toBeInstanceOf(Uint8Array);
		expect(local.getText("t").toString().startsWith("new")).toBe(true);
		expect(provider.burstBytes[0]).toBeLessThan(1_000);
	});
});

describe("YStreamClient error reporting", () => {
	it("reports a frame larger than maxFrameSize and ends the connection", async () => {
		const provider = inProcessProvider(docWithText("t", "x".repeat(10_000)));
		const errors: unknown[] = [];
		const client = new YStreamClient(new Doc(), {
			stub: provider.stub,
			maxFrameSize: 64,
			onError: (error) => errors.push(error),
		});
		await client.connect();

		expect(client.status).toBe("disconnected");
		expect(errors.length).toBe(1);
		expect(String(errors[0])).toContain("exceeds maximum");
	});

	it("reports a subscribe failure", async () => {
		const provider = inProcessProvider(new Doc());
		const errors: unknown[] = [];
		const client = new YStreamClient(new Doc(), {
			stub: {
				...provider.stub,
				subscribe: async () => {
					throw new Error("provider unavailable");
				},
			},
			onError: (error) => errors.push(error),
		});
		await client.connect();
		expect(await client.syncOnce()).toBe(false);

		expect(errors.map(String)).toEqual([
			"Error: provider unavailable",
			"Error: provider unavailable",
		]);
	});

	it("syncOnce reports a malformed stream as failure", async () => {
		const provider = inProcessProvider(new Doc());
		const errors: unknown[] = [];
		const client = new YStreamClient(new Doc(), {
			stub: {
				...provider.stub,
				subscribe: async () =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							// part header [total=1][index=0] followed by an empty message
							controller.enqueue(encodeFrame(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0])));
							controller.close();
						},
					}),
			},
			onError: (error) => errors.push(error),
		});

		expect(await client.syncOnce()).toBe(false);
		expect(errors.length).toBe(1);
	});
});

describe("YStreamClient reconnect status", () => {
	it("never reports disconnected between attempts", async () => {
		const provider = inProcessProvider(new Doc());
		const client = new YStreamClient(new Doc(), {
			stub: {
				...provider.stub,
				subscribe: async () => {
					throw new Error("provider unavailable");
				},
			},
			reconnect: { maxRetries: 3, initialDelay: 5 },
			onError: () => {},
		});
		const seen: YStreamClientStatus[] = [];
		client.onStatusChange((status) => seen.push(status));

		await client.connect();

		expect(seen.filter((status) => status === "disconnected")).toEqual(["disconnected"]);
		expect(seen.at(-1)).toBe("disconnected");
		expect(seen.filter((status) => status === "connecting").length).toBe(4);
	});
});
