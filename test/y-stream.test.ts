import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import { YStreamProvider } from "../src/provider";

import type { TestProvider } from "./worker";
import type { TestSubscriber } from "./worker";

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function getProvider(name: string) {
	return env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName(name));
}

function getSubscriber(name: string) {
	return env.Y_STREAM_SUBSCRIBER.get(
		env.Y_STREAM_SUBSCRIBER.idFromName(name),
	);
}

/** Create a Yjs state update that inserts text at position 0 in a named Y.Text field. */
function createTextUpdate(field: string, content: string): Uint8Array {
	const doc = new Doc();
	doc.getText(field).insert(0, content);
	return encodeStateAsUpdate(doc);
}

/** Decode a full Yjs state vector back into a Doc for assertions. */
function decodeDoc(state: Uint8Array): Doc {
	const doc = new Doc();
	applyUpdate(doc, state);
	return doc;
}

/** Poll until the subscriber reports synced or throw after timeout. */
async function waitForSync(
	sub: { getSynced(): Promise<boolean> },
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await sub.getSynced()) return;
		await delay(50);
	}
	throw new Error(
		`Subscriber did not reach synced state within ${timeoutMs}ms`,
	);
}

/** Poll until a subscriber's Y.Text field matches the expected string. */
async function waitForSubscriberText(
	sub: { getText(name: string): Promise<string> },
	field: string,
	expected: string,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = await sub.getText(field);
		if (text === expected) return;
		await delay(50);
	}
	// Final assertion so the error message is descriptive on failure
	expect(await sub.getText(field)).toBe(expected);
}

/** Poll until the provider's Y.Text field matches the expected string. */
async function waitForProviderText(
	provider: { getYDoc(): Promise<Uint8Array> },
	field: string,
	expected: string,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await provider.getYDoc();
		const doc = decodeDoc(state);
		if (doc.getText(field).toString() === expected) return;
		await delay(50);
	}
	const state = await provider.getYDoc();
	const doc = decodeDoc(state);
	expect(doc.getText(field).toString()).toBe(expected);
}

// ──────────────────────────────────────────────────────────
// Provider
// ──────────────────────────────────────────────────────────

describe("YStreamProvider", () => {
	it("initializes with an empty document", async () => {
		const provider = getProvider("p-init-empty");
		const state = await provider.getYDoc();
		const doc = decodeDoc(state);

		expect(doc.getText("root").toString()).toBe("");
	});

	it("is an instance of YStreamProvider", async () => {
		const provider = getProvider("p-instanceof");
		await runInDurableObject(provider, async (instance: TestProvider) => {
			expect(instance).toBeInstanceOf(YStreamProvider);
		});
	});

	it("applies a single update and returns the correct state", async () => {
		const provider = getProvider("p-apply-single");
		await provider.applyUpdate(createTextUpdate("root", "hello world"));

		const doc = decodeDoc(await provider.getYDoc());
		expect(doc.getText("root").toString()).toBe("hello world");
	});

	it("applies updates to multiple Y.Text fields", async () => {
		const provider = getProvider("p-apply-multi-field");

		await provider.applyUpdate(createTextUpdate("title", "My Title"));
		await provider.applyUpdate(createTextUpdate("body", "My Body"));

		const doc = decodeDoc(await provider.getYDoc());
		expect(doc.getText("title").toString()).toBe("My Title");
		expect(doc.getText("body").toString()).toBe("My Body");
	});
});

// ──────────────────────────────────────────────────────────
// Client connection
// ──────────────────────────────────────────────────────────

describe("YStreamClient connection", () => {
	it("syncs with an empty provider and reaches synced status", async () => {
		const sub = getSubscriber("c-conn-empty-sub");
		await sub.connectToProvider("c-conn-empty-provider");
		await waitForSync(sub);

		expect(await sub.getStatus()).toBe("synced");
		expect(await sub.getSynced()).toBe(true);
		expect(await sub.getText("root")).toBe("");
	});

	it("reports no-client before connecting", async () => {
		const sub = getSubscriber("c-no-client-sub");
		expect(await sub.getStatus()).toBe("no-client");
		expect(await sub.getSynced()).toBe(false);
	});

	it("receives pre-existing provider state on connect", async () => {
		const providerName = "c-preexist-provider";
		const provider = getProvider(providerName);
		await provider.applyUpdate(createTextUpdate("root", "pre-existing"));

		const sub = getSubscriber("c-preexist-sub");
		await sub.connectToProvider(providerName);

		await waitForSubscriberText(sub, "root", "pre-existing");
	});

	it("receives pre-existing state across multiple fields", async () => {
		const providerName = "c-preexist-multi-provider";
		const provider = getProvider(providerName);
		await provider.applyUpdate(createTextUpdate("alpha", "AAA"));
		await provider.applyUpdate(createTextUpdate("beta", "BBB"));

		const sub = getSubscriber("c-preexist-multi-sub");
		await sub.connectToProvider(providerName);

		await waitForSubscriberText(sub, "alpha", "AAA");
		await waitForSubscriberText(sub, "beta", "BBB");
	});
});

// ──────────────────────────────────────────────────────────
// Provider → Subscriber propagation
// ──────────────────────────────────────────────────────────

describe("Provider to subscriber sync", () => {
	it("propagates a provider update to a connected subscriber", async () => {
		const providerName = "p2s-basic-provider";
		const provider = getProvider(providerName);
		const sub = getSubscriber("p2s-basic-sub");

		await sub.connectToProvider(providerName);
		await waitForSync(sub);

		// Mutate the provider after the subscriber has synced
		await provider.applyUpdate(createTextUpdate("root", "streamed"));

		await waitForSubscriberText(sub, "root", "streamed");
	});

	it("propagates multiple sequential updates", async () => {
		const providerName = "p2s-seq-provider";
		const provider = getProvider(providerName);
		const sub = getSubscriber("p2s-seq-sub");

		await sub.connectToProvider(providerName);
		await waitForSync(sub);

		await provider.applyUpdate(createTextUpdate("a", "first"));
		await waitForSubscriberText(sub, "a", "first");

		await provider.applyUpdate(createTextUpdate("b", "second"));
		await waitForSubscriberText(sub, "b", "second");

		await provider.applyUpdate(createTextUpdate("c", "third"));
		await waitForSubscriberText(sub, "c", "third");
	});
});

// ──────────────────────────────────────────────────────────
// Subscriber → Provider propagation
// ──────────────────────────────────────────────────────────

describe("Subscriber to provider sync", () => {
	it("propagates a subscriber's local change to the provider", async () => {
		const providerName = "s2p-basic-provider";
		const provider = getProvider(providerName);
		const sub = getSubscriber("s2p-basic-sub");

		await sub.connectToProvider(providerName);
		await waitForSync(sub);

		// Subscriber makes a local change
		await sub.insertText("root", 0, "from subscriber");

		await waitForProviderText(provider, "root", "from subscriber");
	});

	it("propagates multiple subscriber changes", async () => {
		const providerName = "s2p-multi-provider";
		const provider = getProvider(providerName);
		const sub = getSubscriber("s2p-multi-sub");

		await sub.connectToProvider(providerName);
		await waitForSync(sub);

		await sub.insertText("x", 0, "one");
		await waitForProviderText(provider, "x", "one");

		await sub.insertText("y", 0, "two");
		await waitForProviderText(provider, "y", "two");
	});
});

// ──────────────────────────────────────────────────────────
// Multi-subscriber sync
// ──────────────────────────────────────────────────────────

describe("Multi-subscriber sync", () => {
	it("propagates provider updates to multiple subscribers", async () => {
		const providerName = "ms-broadcast-provider";
		const provider = getProvider(providerName);
		const subA = getSubscriber("ms-broadcast-a");
		const subB = getSubscriber("ms-broadcast-b");

		await subA.connectToProvider(providerName);
		await subB.connectToProvider(providerName);
		await waitForSync(subA);
		await waitForSync(subB);

		await provider.applyUpdate(createTextUpdate("root", "broadcast"));

		await waitForSubscriberText(subA, "root", "broadcast");
		await waitForSubscriberText(subB, "root", "broadcast");
	});

	it("propagates one subscriber's changes to another via the provider", async () => {
		const providerName = "ms-cross-provider";
		const provider = getProvider(providerName);
		const subA = getSubscriber("ms-cross-a");
		const subB = getSubscriber("ms-cross-b");

		await subA.connectToProvider(providerName);
		await subB.connectToProvider(providerName);
		await waitForSync(subA);
		await waitForSync(subB);

		// subA makes a local change
		await subA.insertText("root", 0, "from A");

		// Change should flow: subA → provider → subB
		await waitForProviderText(provider, "root", "from A");
		await waitForSubscriberText(subB, "root", "from A");
	});

	it("both subscribers receive pre-existing state on connect", async () => {
		const providerName = "ms-preexist-provider";
		const provider = getProvider(providerName);
		await provider.applyUpdate(createTextUpdate("root", "shared state"));

		const subA = getSubscriber("ms-preexist-a");
		const subB = getSubscriber("ms-preexist-b");

		await subA.connectToProvider(providerName);
		await subB.connectToProvider(providerName);

		await waitForSubscriberText(subA, "root", "shared state");
		await waitForSubscriberText(subB, "root", "shared state");
	});
});

// ──────────────────────────────────────────────────────────
// Disconnect
// ──────────────────────────────────────────────────────────

describe("Disconnect", () => {
	it("subscriber disconnects and reports correct status", async () => {
		const sub = getSubscriber("dc-status-sub");
		await sub.connectToProvider("dc-status-provider");
		await waitForSync(sub);

		expect(await sub.getStatus()).toBe("synced");

		await sub.disconnect();

		// After disconnect the client reference is nulled in TestSubscriber
		expect(await sub.getStatus()).toBe("no-client");
		expect(await sub.getSynced()).toBe(false);
	});

	it("provider continues streaming to remaining subscribers after one disconnects", async () => {
		const providerName = "dc-continue-provider";
		const provider = getProvider(providerName);
		const subA = getSubscriber("dc-continue-a");
		const subB = getSubscriber("dc-continue-b");

		await subA.connectToProvider(providerName);
		await subB.connectToProvider(providerName);
		await waitForSync(subA);
		await waitForSync(subB);

		// Disconnect subA
		await subA.disconnect();

		// Provider updates should still reach subB
		await provider.applyUpdate(createTextUpdate("root", "after disconnect"));
		await waitForSubscriberText(subB, "root", "after disconnect");
	});

	it("provider handles update when no subscribers remain", async () => {
		const providerName = "dc-no-subs-provider";
		const provider = getProvider(providerName);
		const sub = getSubscriber("dc-no-subs-sub");

		await sub.connectToProvider(providerName);
		await waitForSync(sub);
		await sub.disconnect();

		// Applying an update to the provider with no subscribers should not throw
		await provider.applyUpdate(createTextUpdate("root", "no one listening"));

		const doc = decodeDoc(await provider.getYDoc());
		expect(doc.getText("root").toString()).toBe("no one listening");
	});
});

// ──────────────────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────────────────

describe("Provider persistence", () => {
	it("persists document state via applyUpdate", async () => {
		const providerName = "persist-basic-provider";
		const provider = getProvider(providerName);

		await provider.applyUpdate(createTextUpdate("root", "persisted"));

		// Reading the doc back should reflect the stored state
		const doc = decodeDoc(await provider.getYDoc());
		expect(doc.getText("root").toString()).toBe("persisted");
	});

	it("new subscriber receives persisted state from a previous session", async () => {
		const providerName = "persist-new-sub-provider";
		const provider = getProvider(providerName);

		// First subscriber connects, makes a change, then disconnects
		const sub1 = getSubscriber("persist-sub-1");
		await sub1.connectToProvider(providerName);
		await waitForSync(sub1);
		await sub1.insertText("root", 0, "from first subscriber");
		await waitForProviderText(provider, "root", "from first subscriber");
		await sub1.disconnect();

		// Allow compaction to complete after last subscriber disconnects
		await delay(200);

		// Second subscriber connects and should see the state
		const sub2 = getSubscriber("persist-sub-2");
		await sub2.connectToProvider(providerName);
		await waitForSubscriberText(sub2, "root", "from first subscriber");
	});
});
