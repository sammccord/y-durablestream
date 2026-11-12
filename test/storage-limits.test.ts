import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import { DurableObjectKvStorage } from "../src/storage/kv";
import { DurableObjectSqlStorage } from "../src/storage/sql";

import type { YDocStorage, YDocStorageOptions } from "../src/storage/types";

// ──────────────────────────────────────────────────────────
// Both backends against real Durable Object storage:
//
// 1. A snapshot larger than one storage value (2 MB) persists and reloads.
// 2. A snapshot that shrinks leaves no stale chunks behind.
// 3. A single update larger than one storage value persists.
// 4. Persistence never garbage-collects: a `gc: false` provider's deleted
//    content survives both reload and threshold compaction.
// 5. The byte threshold scales with the snapshot, so a large document is
//    not rewritten for every `maxBytes` of edits.
// 6. Compaction snapshots the live document when one is passed.
// 7. `loadInto` applies persisted state straight to the given document.
// ──────────────────────────────────────────────────────────

const BIG = 3_000_000;

const backends = [
	{
		name: "DurableObjectSqlStorage",
		make: (state: DurableObjectState, options: YDocStorageOptions = { maxUpdates: 2 }): YDocStorage =>
			new DurableObjectSqlStorage(state.storage, options),
		pendingUpdates: async (state: DurableObjectState) =>
			state.storage.sql.exec("SELECT id FROM yjs_updates").toArray().length,
	},
	{
		name: "DurableObjectKvStorage",
		make: (state: DurableObjectState, options: YDocStorageOptions = { maxUpdates: 2 }): YDocStorage =>
			new DurableObjectKvStorage(state.storage, options),
		pendingUpdates: async (state: DurableObjectState) =>
			(await state.storage.list({ prefix: "ydoc:update:" })).size,
	},
];

/** `count` independent updates of roughly `bytes` each. */
function updatesOf(count: number, bytes: number): Uint8Array[] {
	return Array.from({ length: count }, (_, index) => {
		const doc = new Doc();
		doc.getText(`field-${index}`).insert(0, "y".repeat(bytes));
		return encodeStateAsUpdate(doc);
	});
}

let counter = 0;
function freshObject() {
	return env.Y_COMMIT_PROVIDER.get(env.Y_COMMIT_PROVIDER.idFromName(`storage-limits-${counter++}`));
}

function docWithText(content: string): Doc {
	const doc = new Doc();
	doc.getText("t").insert(0, content);
	return doc;
}

/** Deleted-but-retained string content present in the doc's struct store. */
function retainedDeletedText(doc: Doc): string {
	const probe = new Doc({ gc: false });
	applyUpdate(probe, encodeStateAsUpdate(doc));
	let text = "";
	for (const structs of probe.store.clients.values()) {
		for (const struct of structs) {
			if (struct.deleted && "content" in struct && "str" in struct.content) {
				text += String(struct.content.str);
			}
		}
	}
	return text;
}

for (const backend of backends) {
	describe(`${backend.name} limits`, () => {
		it("persists and reloads a snapshot larger than one storage value", async () => {
			await runInDurableObject(freshObject(), async (_instance, state) => {
				const storage = backend.make(state);
				await storage.commit(docWithText("x".repeat(BIG)));
				const loaded = await backend.make(state).getYDoc();
				expect(loaded.getText("t").length).toBe(BIG);
			});
		});

		it("leaves no stale chunks when the snapshot shrinks", async () => {
			await runInDurableObject(freshObject(), async (_instance, state) => {
				const storage = backend.make(state);
				await storage.commit(docWithText("x".repeat(BIG)));
				await storage.commit(docWithText("small"));
				const loaded = await backend.make(state).getYDoc();
				expect(loaded.getText("t").toString()).toBe("small");
			});
		});

		it("persists a single update larger than one storage value", async () => {
			await runInDurableObject(freshObject(), async (_instance, state) => {
				const storage = backend.make(state);
				await storage.storeUpdate(encodeStateAsUpdate(docWithText("x".repeat(BIG))));
				const after = new Doc();
				after.getText("u").insert(0, "after");
				await storage.storeUpdate(encodeStateAsUpdate(after));
				const loaded = await backend.make(state).getYDoc();
				expect(loaded.getText("t").length).toBe(BIG);
				expect(loaded.getText("u").toString()).toBe("after");
			});
		});

		it("keeps deleted content through reload and threshold compaction", async () => {
			await runInDurableObject(freshObject(), async (_instance, state) => {
				const storage = backend.make(state);
				const source = new Doc({ gc: false });
				const updates: Uint8Array[] = [];
				source.on("update", (update: Uint8Array) => updates.push(update));
				source.getText("t").insert(0, "history");
				source.getText("t").delete(0, 7);
				source.getText("t").insert(0, "a");
				source.getText("t").insert(1, "b");
				expect(updates.length).toBeGreaterThan(2);
				for (const update of updates) await storage.storeUpdate(update);

				const loaded = await backend.make(state).getYDoc();
				expect(loaded.getText("t").toString()).toBe("ab");
				expect(retainedDeletedText(loaded)).toBe("history");
			});
		});

		it("scales the byte threshold with the snapshot size", async () => {
			await runInDurableObject(freshObject(), async (_instance, state) => {
				const options = { maxBytes: 1_000, maxUpdates: 1_000 };
				const storage = backend.make(state, options);
				await storage.commit(docWithText("x".repeat(100_000)));

				// 5 × ~2 KB is over maxBytes but under 25% of the 100 KB snapshot.
				for (const update of updatesOf(5, 2_000)) await storage.storeUpdate(update);
				expect(await backend.pendingUpdates(state)).toBe(5);

				// A fresh instance derives the same threshold from storage.
				const reopened = backend.make(state, options);
				for (const update of updatesOf(10, 2_000)) await reopened.storeUpdate(update);
				expect(await backend.pendingUpdates(state)).toBeLessThan(15);

				const fixed = backend.make(state, { ...options, snapshotGrowthRatio: 0 });
				await fixed.commit(docWithText("x".repeat(100_000)));
				for (const update of updatesOf(5, 2_000)) await fixed.storeUpdate(update);
				expect(await backend.pendingUpdates(state)).toBe(0);
			});
		});

		it("snapshots the live document on compaction when given one", async () => {
			await runInDurableObject(freshObject(), async (_instance, state) => {
				const storage = backend.make(state, { maxUpdates: 1 });
				const live = docWithText("only in the live doc");
				const [first, second] = updatesOf(2, 10);
				await storage.storeUpdate(first, live);
				await storage.storeUpdate(second, live);

				expect(await backend.pendingUpdates(state)).toBe(0);
				const loaded = await backend.make(state).getYDoc();
				expect(loaded.getText("t").toString()).toBe("only in the live doc");
			});
		});

		it("loadInto applies persisted state to the given document", async () => {
			await runInDurableObject(freshObject(), async (_instance, state) => {
				const storage = backend.make(state, { maxUpdates: 10 });
				await storage.commit(docWithText("snapshot"));
				const extra = new Doc();
				extra.getText("u").insert(0, "update");
				await storage.storeUpdate(encodeStateAsUpdate(extra));

				const target = new Doc();
				await backend.make(state).loadInto?.(target);
				expect(target.getText("t").toString()).toBe("snapshot");
				expect(target.getText("u").toString()).toBe("update");
			});
		});
	});
}
