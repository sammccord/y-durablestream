import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Doc, createDocFromSnapshot, snapshot } from "yjs";

import { YStreamProvider } from "../src/provider";
import { DurableObjectSqlStorage } from "../src/storage/sql";

import type { YDocStorage } from "../src/storage/types";
import type { YStreamProviderOptions } from "../src/types";

class SqlProvider extends YStreamProvider {
	protected override createStorage(): YDocStorage {
		return new DurableObjectSqlStorage(this.ctx.storage, { maxUpdates: this.maxUpdates });
	}
}

const backends = [
	["KV", YStreamProvider],
	["SQL", SqlProvider],
] as const;

/**
 * A provider over `state`'s storage whose startup and background writes the
 * test can await. Inside `runInDurableObject` the real `blockConcurrencyWhile`
 * defers until the callback returns, so the constructor's load would never
 * run; shadowing it on the state lets the test drive startup directly.
 */
function harness(
	Provider: (typeof backends)[number][1],
	state: DurableObjectState,
	options: YStreamProviderOptions,
) {
	const pending: Promise<unknown>[] = [];
	Object.defineProperties(state, {
		waitUntil: { configurable: true, value: (promise: Promise<unknown>) => void pending.push(promise) },
		blockConcurrencyWhile: {
			configurable: true,
			value: <T,>(callback: () => Promise<T>) => {
				const started = callback();
				pending.push(started);
				return started;
			},
		},
	});
	const provider = new Provider(state, env, options);
	const settled = async () => {
		while (pending.length > 0) await pending.shift();
	};
	return { provider, settled };
}

describe.each(backends)("%s storage with gc: false", (name, Provider) => {
	it("keeps deleted content through compaction and reload", async () => {
		const stub = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName(`gc-false-${name}`));
		await runInDurableObject(stub, async (_instance, state) => {
			const writer = harness(Provider, state, { gc: false, maxUpdates: 2 });
			await writer.settled();
			const source = new Doc({ gc: false });
			const updates: Uint8Array[] = [];
			source.on("update", (update: Uint8Array) => updates.push(update));
			source.getText("t").insert(0, "hello world");
			const before = snapshot(source);
			source.getText("t").delete(0, 6);
			source.getText("t").insert(0, "!");
			for (const update of updates) await writer.provider.applyUpdate(update);
			await writer.settled();

			const reloaded = harness(Provider, state, { gc: false });
			await reloaded.settled();
			const doc = reloaded.provider["doc"];

			expect(doc.getText("t").toString()).toBe("!world");
			expect(createDocFromSnapshot(doc, before).getText("t").toString()).toBe(
				"hello world",
			);
		});
	});
});

describe("SQL storage compaction", () => {
	it("does not rewrite a large snapshot for a small volume of updates", async () => {
		const stub = env.Y_STREAM_PROVIDER.get(env.Y_STREAM_PROVIDER.idFromName("sql-compaction-cost"));
		await runInDurableObject(stub, async (_instance, state) => {
			let snapshotWrites = 0;
			const storage = new DurableObjectSqlStorage({
				sql: {
					exec: (query: string, ...bindings: unknown[]) => {
						if (query.includes("INTO yjs_snapshot")) snapshotWrites++;
						return state.storage.sql.exec(query, ...bindings);
					},
				},
				transactionSync: (closure) => state.storage.transactionSync(closure),
			});

			const doc = new Doc();
			doc.getText("big").insert(0, "x".repeat(200_000));
			await storage.commit(doc);
			const seeded = snapshotWrites;

			const updates: Uint8Array[] = [];
			doc.on("update", (update: Uint8Array) => updates.push(update));
			for (let i = 0; i < 100; i++) doc.getText("small").insert(0, "y".repeat(200));
			for (const update of updates) await storage.storeUpdate(update, doc);

			expect(snapshotWrites - seeded).toBe(0);
		});
	});
});
