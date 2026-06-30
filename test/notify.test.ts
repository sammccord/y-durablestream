import { env } from "cloudflare:test";
import { createEncoder, toUint8Array, writeVarUint } from "lib0/encoding";
import { writeUpdate } from "y-protocols/sync";
import { describe, expect, it } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

// ──────────────────────────────────────────────────────────
// Notify-push: registry + pushToSubscriber + syncOnce
//
// These exercise the live-delivery path for Durable Object subscribers, which
// cannot hold a persistent stream past the request that opened it. A receiver
// REGISTERS (no open stream) and the provider RPCs it (pushToSubscriber) on
// every applied update, except the originator (echo suppression).
// ──────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function getNotifyProvider(name: string) {
	return env.Y_NOTIFY_PROVIDER.get(env.Y_NOTIFY_PROVIDER.idFromName(name));
}

function getReceiver(name: string) {
	return env.Y_NOTIFY_RECEIVER.get(env.Y_NOTIFY_RECEIVER.idFromName(name));
}

/** A Yjs state update inserting text at position 0 in a named Y.Text field. */
function createTextUpdate(field: string, content: string): Uint8Array {
	const doc = new Doc();
	doc.getText(field).insert(0, content);
	return encodeStateAsUpdate(doc);
}

/** Wrap a raw update in a Yjs sync Update protocol message (for `update()`). */
function syncUpdateMsg(update: Uint8Array): Uint8Array {
	const e = createEncoder();
	writeVarUint(e, 0); // MESSAGE_SYNC
	writeUpdate(e, update);
	return toUint8Array(e);
}

function decodeDoc(state: Uint8Array): Doc {
	const doc = new Doc();
	applyUpdate(doc, state);
	return doc;
}

async function waitForText(
	r: { getText(field: string): Promise<string> },
	field: string,
	expected: string,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await r.getText(field)) === expected) return;
		await delay(50);
	}
	expect(await r.getText(field)).toBe(expected);
}

describe("Notify-push registry", () => {
	it("delivers an applied update to a registered receiver with no open stream", async () => {
		const provider = getNotifyProvider("np-deliver");
		const r = getReceiver("recv-deliver");
		await r.register("np-deliver", "recv-deliver");

		// A server-side change; no subscribe() stream exists for the receiver.
		await provider.applyUpdate(createTextUpdate("root", "live"));

		await waitForText(r, "root", "live");
	});

	it("stops delivering after deregister", async () => {
		const provider = getNotifyProvider("np-dereg");
		const r = getReceiver("recv-dereg");
		await r.register("np-dereg", "recv-dereg");
		await r.deregister("np-dereg", "recv-dereg");

		await provider.applyUpdate(createTextUpdate("root", "nope"));
		await delay(300); // give any erroneous push time to land

		expect(await r.getText("root")).toBe("");
	});

	it("suppresses the echo to the originating subscriber but delivers to others", async () => {
		const provider = getNotifyProvider("np-echo");
		const origin = getReceiver("recv-origin");
		const other = getReceiver("recv-other");
		await origin.register("np-echo", "recv-origin");
		await other.register("np-echo", "recv-other");

		// A write whose origin clientId is "recv-origin".
		await provider.update(syncUpdateMsg(createTextUpdate("root", "X")), "recv-origin");

		await waitForText(other, "root", "X"); // non-origin receives it
		await delay(200);
		expect(await origin.getText("root")).toBe(""); // origin is skipped
	});
});

describe("YStreamClient.syncOnce", () => {
	it("pulls provider state and pushes local state in one shot, with no persistent connection", async () => {
		const provider = getNotifyProvider("np-synconce");
		await provider.applyUpdate(createTextUpdate("alpha", "P")); // provider has alpha=P

		const r = getReceiver("recv-synconce");
		await r.insertText("beta", 0, "S"); // receiver has beta=S locally

		await r.syncOnceWith("np-synconce");

		// pull half: receiver received the provider's state
		expect(await r.getText("alpha")).toBe("P");
		// push half: provider received the receiver's state
		const doc = decodeDoc(await provider.getYDoc());
		expect(doc.getText("beta").toString()).toBe("S");
		// syncOnce does not open a persistent connection
		expect(await r.getStatus()).toBe("disconnected");
	});
});
