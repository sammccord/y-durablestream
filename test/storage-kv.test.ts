import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Doc, encodeStateAsUpdate, applyUpdate } from "yjs";

import { DurableObjectKvStorage } from "../src/storage/kv";

// ──────────────────────────────────────────────────────────
// Mock storage types matching the KvStorageLike interface
// ──────────────────────────────────────────────────────────

interface MockTransaction {
	get: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
	put: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
}

interface MockStorage extends MockTransaction {
	transaction: ReturnType<typeof vi.fn>;
}

function createMockStorage(): MockStorage {
	const storage: MockStorage = {
		get: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue(new Map()),
		put: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(0),
		transaction: vi.fn(async (closure: (txn: MockTransaction) => Promise<unknown>) => {
			return closure(storage);
		}),
	};
	return storage;
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function createDocWithText(field: string, content: string): Doc {
	const doc = new Doc();
	doc.getText(field).insert(0, content);
	return doc;
}

function createUpdateFromText(field: string, content: string): Uint8Array {
	return encodeStateAsUpdate(createDocWithText(field, content));
}

async function loadDoc(kvStorage: DurableObjectKvStorage): Promise<Doc> {
	const doc = new Doc();
	const state = await kvStorage.load();
	if (state) applyUpdate(doc, state);
	return doc;
}

/** Store `update` the way the provider does: after applying it to the live doc. */
function store(kvStorage: DurableObjectKvStorage, live: Doc, update: Uint8Array): Promise<void> {
	applyUpdate(live, update);
	return kvStorage.storeUpdate(update, live);
}

// ──────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────

describe("DurableObjectKvStorage", () => {
	let storage: MockStorage;

	beforeEach(() => {
		storage = createMockStorage();
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.resetAllMocks();
	});

	// ════════════════════════════════════
	// Constructor / Options
	// ════════════════════════════════════

	describe("constructor", () => {
		it("creates an instance with default options", () => {
			const kvStorage = new DurableObjectKvStorage(storage);
			expect(kvStorage).toBeInstanceOf(DurableObjectKvStorage);
		});

		it("accepts custom maxBytes and maxUpdates", () => {
			const kvStorage = new DurableObjectKvStorage(storage, {
				maxBytes: 2048,
				maxUpdates: 50,
			});
			expect(kvStorage).toBeInstanceOf(DurableObjectKvStorage);
		});

		it("throws if maxBytes exceeds 128 KB", () => {
			expect(() => {
				new DurableObjectKvStorage(storage, {
					maxBytes: 128 * 1024 + 1,
				});
			}).toThrow("maxBytes must not exceed 128 KB");
		});

		it("allows maxBytes exactly at 128 KB", () => {
			expect(() => {
				new DurableObjectKvStorage(storage, {
					maxBytes: 128 * 1024,
				});
			}).not.toThrow();
		});
	});

	// ════════════════════════════════════
	// load
	// ════════════════════════════════════

	describe("load", () => {
		it("returns null when nothing is stored", async () => {
			storage.get.mockResolvedValue(undefined);
			storage.list.mockResolvedValue(new Map());

			const kvStorage = new DurableObjectKvStorage(storage);

			expect(await kvStorage.load()).toBeNull();
		});

		it("reads the snapshot from ydoc:state:doc key", async () => {
			const kvStorage = new DurableObjectKvStorage(storage);
			await loadDoc(kvStorage);

			expect(storage.get).toHaveBeenCalledWith("ydoc:state:doc");
		});

		it("lists incremental updates with prefix ydoc:update:", async () => {
			const kvStorage = new DurableObjectKvStorage(storage);
			await loadDoc(kvStorage);

			expect(storage.list).toHaveBeenCalledWith({ prefix: "ydoc:update:" });
		});

		it("reconstructs a Doc from a snapshot alone", async () => {
			const original = createDocWithText("root", "snapshot content");
			const snapshot = encodeStateAsUpdate(original);

			storage.get.mockResolvedValue(snapshot);
			storage.list.mockResolvedValue(new Map());

			const kvStorage = new DurableObjectKvStorage(storage);
			const doc = await loadDoc(kvStorage);

			expect(doc.getText("root").toString()).toBe("snapshot content");
		});

		it("reconstructs a Doc from incremental updates alone", async () => {
			const update1 = createUpdateFromText("root", "hello");
			const update2 = createUpdateFromText("field2", "world");

			storage.get.mockResolvedValue(undefined);
			storage.list.mockResolvedValue(
				new Map([
					["ydoc:update:1", update1],
					["ydoc:update:2", update2],
				]),
			);

			const kvStorage = new DurableObjectKvStorage(storage);
			const doc = await loadDoc(kvStorage);

			expect(doc.getText("root").toString()).toBe("hello");
			expect(doc.getText("field2").toString()).toBe("world");
		});

		it("reconstructs a Doc from snapshot + incremental updates", async () => {
			const snapshotDoc = createDocWithText("root", "base");
			const snapshot = encodeStateAsUpdate(snapshotDoc);

			const additionalDoc = new Doc();
			applyUpdate(additionalDoc, snapshot);
			additionalDoc.getText("extra").insert(0, "added");
			const incrementalUpdate = encodeStateAsUpdate(additionalDoc);

			storage.get.mockResolvedValue(snapshot);
			storage.list.mockResolvedValue(
				new Map([["ydoc:update:1", incrementalUpdate]]),
			);

			const kvStorage = new DurableObjectKvStorage(storage);
			const doc = await loadDoc(kvStorage);

			expect(doc.getText("root").toString()).toBe("base");
			expect(doc.getText("extra").toString()).toBe("added");
		});
	});

	// ════════════════════════════════════
	// storeUpdate
	// ════════════════════════════════════

	describe("storeUpdate", () => {
		it("stores the first update with correct keys", async () => {
			storage.get.mockResolvedValue(undefined); // bytes = 0, count = 0

			const update = new Uint8Array([1, 2, 3, 4, 5]);
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.storeUpdate(update, new Doc());

			expect(storage.transaction).toHaveBeenCalledOnce();
			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 5,
				count: 1,
			});
			expect(storage.put).toHaveBeenCalledWith(
				"ydoc:update:00000000000000000001",
				update,
			);
		});

		it("increments byte count and update count", async () => {
			// Simulate existing state: 10 bytes, 2 updates
			storage.get.mockImplementation(async (key: string) => {
				if (key === "ydoc:state:meta") return { bytes: 10, count: 2 };
				return undefined;
			});

			const update = new Uint8Array([1, 2, 3]); // 3 bytes
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.storeUpdate(update, new Doc());

			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 13,
				count: 3,
			});
			expect(storage.put).toHaveBeenCalledWith(
				"ydoc:update:00000000000000000003",
				update,
			);
		});

		it("migrates legacy split counter keys to the meta key", async () => {
			// Pre-0.9 layout: separate bytes/count keys, no meta key.
			storage.get.mockImplementation(async (key: string) => {
				if (key === "ydoc:state:bytes") return 10;
				if (key === "ydoc:state:count") return 2;
				return undefined;
			});

			const update = new Uint8Array([1, 2, 3]);
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.storeUpdate(update, new Doc());

			// Legacy keys removed, merged meta written with migrated counters.
			expect(storage.delete).toHaveBeenCalledWith([
				"ydoc:state:bytes",
				"ydoc:state:count",
			]);
			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 13,
				count: 3,
			});
		});

		it("uses a transaction for atomicity", async () => {
			const update = new Uint8Array([1]);
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.storeUpdate(update, new Doc());

			expect(storage.transaction).toHaveBeenCalledOnce();
			expect(storage.transaction).toHaveBeenCalledWith(expect.any(Function));
		});

		it("compacts when maxBytes is exceeded", async () => {
			// Storage has 9000 bytes already, and we add a chunk that pushes it over 10KB
			const largeUpdate = new Uint8Array(2000);
			storage.get.mockImplementation(async (key: string) => {
				if (key === "ydoc:state:meta") return { bytes: 9000, count: 5 };
				return undefined;
			});
			storage.list.mockResolvedValue(new Map());

			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.storeUpdate(largeUpdate, new Doc());

			// Should have written a compacted snapshot
			expect(storage.put).toHaveBeenCalledWith(
				"ydoc:state:doc",
				expect.any(Uint8Array),
			);
			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 0,
				count: 0,
				snapshotBytes: expect.any(Number),
			});
		});

		it("compacts when maxUpdates is exceeded", async () => {
			storage.get.mockImplementation(async (key: string) => {
				if (key === "ydoc:state:meta") return { bytes: 100, count: 500 }; // at limit
				return undefined;
			});
			storage.list.mockResolvedValue(new Map());

			const update = createUpdateFromText("root", "compact-trigger");
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.storeUpdate(update, new Doc());

			// Count would be 501, exceeding maxUpdates=500 → compact
			expect(storage.put).toHaveBeenCalledWith(
				"ydoc:state:doc",
				expect.any(Uint8Array),
			);
			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 0,
				count: 0,
				snapshotBytes: expect.any(Number),
			});
		});

		it("compacts with custom maxBytes threshold", async () => {
			storage.get.mockImplementation(async (key: string) => {
				if (key === "ydoc:state:meta") return { bytes: 500, count: 3 };
				return undefined;
			});
			storage.list.mockResolvedValue(new Map());

			const update = new Uint8Array(600); // 500 + 600 = 1100 > 1024
			const kvStorage = new DurableObjectKvStorage(storage, { maxBytes: 1024 });
			await kvStorage.storeUpdate(update, new Doc());

			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 0,
				count: 0,
				snapshotBytes: expect.any(Number),
			});
		});

		it("compacts with custom maxUpdates threshold", async () => {
			storage.get.mockImplementation(async (key: string) => {
				if (key === "ydoc:state:meta") return { bytes: 10, count: 5 }; // at limit for maxUpdates=5
				return undefined;
			});
			storage.list.mockResolvedValue(new Map());

			const update = createUpdateFromText("root", "custom-threshold");
			const kvStorage = new DurableObjectKvStorage(storage, { maxUpdates: 5 });
			await kvStorage.storeUpdate(update, new Doc());

			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 0,
				count: 0,
				snapshotBytes: expect.any(Number),
			});
		});

		it("deletes existing update keys during compaction", async () => {
			const existingUpdate1 = createUpdateFromText("a", "1");
			const existingUpdate2 = createUpdateFromText("b", "2");
			const existingUpdate3 = createUpdateFromText("c", "3");

			storage.get.mockImplementation(async (key: string) => {
				if (key === "ydoc:state:meta") return { bytes: 99999, count: 3 };
				return undefined;
			});
			storage.list.mockResolvedValue(
				new Map([
					["ydoc:update:1", existingUpdate1],
					["ydoc:update:2", existingUpdate2],
					["ydoc:update:3", existingUpdate3],
				]),
			);

			const update = createUpdateFromText("d", "4");
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.storeUpdate(update, new Doc());

			expect(storage.delete).toHaveBeenCalledWith([
				"ydoc:update:1",
				"ydoc:update:2",
				"ydoc:update:3",
			]);
		});

		it("raises the byte threshold to the snapshot size", async () => {
			storage.get.mockImplementation(async (key: string) => {
				if (key === "ydoc:state:meta") return { bytes: 15_000, count: 5, snapshotBytes: 50_000 };
				return undefined;
			});

			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.storeUpdate(new Uint8Array(100), new Doc());

			expect(storage.put).not.toHaveBeenCalledWith("ydoc:state:doc", expect.anything());
			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 15_100,
				count: 6,
				snapshotBytes: 50_000,
			});
		});

		it("does not compact when under both thresholds", async () => {
			storage.get.mockImplementation(async (key: string) => {
				if (key === "ydoc:state:meta") return { bytes: 100, count: 5 };
				return undefined;
			});

			const update = new Uint8Array([1, 2, 3]);
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.storeUpdate(update, new Doc());

			// Should NOT have written a compacted doc
			expect(storage.put).not.toHaveBeenCalledWith(
				"ydoc:state:doc",
				expect.anything(),
			);
			// Should have stored the incremental update
			expect(storage.put).toHaveBeenCalledWith(
				"ydoc:update:00000000000000000006",
				update,
			);
		});
	});

	// ════════════════════════════════════
	// commit
	// ════════════════════════════════════

	describe("commit", () => {
		it("writes the doc state as a snapshot", async () => {
			storage.list.mockResolvedValue(new Map());

			const doc = createDocWithText("root", "commit test");
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.commit(doc);

			expect(storage.transaction).toHaveBeenCalledOnce();
			expect(storage.put).toHaveBeenCalledWith(
				"ydoc:state:doc",
				expect.any(Uint8Array),
			);
			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 0,
				count: 0,
				snapshotBytes: expect.any(Number),
			});
		});

		it("deletes existing incremental updates during commit", async () => {
			storage.list.mockResolvedValue(
				new Map([
					["ydoc:update:1", new Uint8Array([1])],
					["ydoc:update:2", new Uint8Array([2])],
				]),
			);

			const doc = new Doc();
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.commit(doc);

			expect(storage.delete).toHaveBeenCalledWith([
				"ydoc:update:1",
				"ydoc:update:2",
			]);
		});

		it("handles commit with no existing updates", async () => {
			storage.list.mockResolvedValue(new Map());

			const doc = new Doc();
			const kvStorage = new DurableObjectKvStorage(storage);

			await expect(kvStorage.commit(doc)).resolves.not.toThrow();

			// Should still write snapshot and reset counters
			expect(storage.put).toHaveBeenCalledWith(
				"ydoc:state:doc",
				expect.any(Uint8Array),
			);
			expect(storage.put).toHaveBeenCalledWith("ydoc:state:meta", {
				bytes: 0,
				count: 0,
				snapshotBytes: expect.any(Number),
			});
		});

		it("preserves document content through commit", async () => {
			storage.list.mockResolvedValue(new Map());

			const doc = createDocWithText("root", "preserved");
			const kvStorage = new DurableObjectKvStorage(storage);
			await kvStorage.commit(doc);

			// Extract the snapshot that was written
			const snapshotCall = storage.put.mock.calls.find(
				(call: unknown[]) => call[0] === "ydoc:state:doc",
			);
			expect(snapshotCall).toBeDefined();

			const writtenSnapshot = snapshotCall![1] as Uint8Array;
			const restored = new Doc();
			applyUpdate(restored, writtenSnapshot);
			expect(restored.getText("root").toString()).toBe("preserved");
		});
	});

	// ════════════════════════════════════
	// Round-trip: store + retrieve
	// ════════════════════════════════════

	describe("round-trip with in-memory mock", () => {
		it("stores an update then retrieves the same doc state", async () => {
			// Use a real in-memory Map to simulate storage
			const data = new Map<string, unknown>();

			const memStorage: MockStorage = {
				get: vi.fn(async (key: string) => data.get(key)),
				list: vi.fn(async (options?: { prefix?: string }) => {
					const prefix = options?.prefix ?? "";
					const result = new Map<string, unknown>();
					for (const [k, v] of data) {
						if (k.startsWith(prefix)) {
							result.set(k, v);
						}
					}
					return result;
				}),
				put: vi.fn(async (key: string, value: unknown) => {
					data.set(key, value);
				}),
				delete: vi.fn(async (keys: string[]) => {
					let count = 0;
					for (const key of keys) {
						if (data.delete(key)) count++;
					}
					return count;
				}),
				transaction: vi.fn(
					async (closure: (txn: MockTransaction) => Promise<unknown>) => {
						return closure(memStorage);
					},
				),
			};

			const kvStorage = new DurableObjectKvStorage(memStorage);

			const update = createUpdateFromText("root", "round-trip");
			await kvStorage.storeUpdate(update, new Doc());

			const doc = await loadDoc(kvStorage);
			expect(doc.getText("root").toString()).toBe("round-trip");
		});

		it("stores multiple updates then retrieves combined state", async () => {
			const data = new Map<string, unknown>();

			const memStorage: MockStorage = {
				get: vi.fn(async (key: string) => data.get(key)),
				list: vi.fn(async (options?: { prefix?: string }) => {
					const prefix = options?.prefix ?? "";
					const result = new Map<string, unknown>();
					for (const [k, v] of data) {
						if (k.startsWith(prefix)) {
							result.set(k, v);
						}
					}
					return result;
				}),
				put: vi.fn(async (key: string, value: unknown) => {
					data.set(key, value);
				}),
				delete: vi.fn(async (keys: string[]) => {
					let count = 0;
					for (const key of keys) {
						if (data.delete(key)) count++;
					}
					return count;
				}),
				transaction: vi.fn(
					async (closure: (txn: MockTransaction) => Promise<unknown>) => {
						return closure(memStorage);
					},
				),
			};

			const kvStorage = new DurableObjectKvStorage(memStorage);
			const live = new Doc();

			await store(kvStorage, live, createUpdateFromText("alpha", "AAA"));
			await store(kvStorage, live, createUpdateFromText("beta", "BBB"));
			await store(kvStorage, live, createUpdateFromText("gamma", "CCC"));

			const doc = await loadDoc(kvStorage);
			expect(doc.getText("alpha").toString()).toBe("AAA");
			expect(doc.getText("beta").toString()).toBe("BBB");
			expect(doc.getText("gamma").toString()).toBe("CCC");
		});

		it("commit then load preserves state", async () => {
			const data = new Map<string, unknown>();

			const memStorage: MockStorage = {
				get: vi.fn(async (key: string) => data.get(key)),
				list: vi.fn(async (options?: { prefix?: string }) => {
					const prefix = options?.prefix ?? "";
					const result = new Map<string, unknown>();
					for (const [k, v] of data) {
						if (k.startsWith(prefix)) {
							result.set(k, v);
						}
					}
					return result;
				}),
				put: vi.fn(async (key: string, value: unknown) => {
					data.set(key, value);
				}),
				delete: vi.fn(async (keys: string[]) => {
					let count = 0;
					for (const key of keys) {
						if (data.delete(key)) count++;
					}
					return count;
				}),
				transaction: vi.fn(
					async (closure: (txn: MockTransaction) => Promise<unknown>) => {
						return closure(memStorage);
					},
				),
			};

			const kvStorage = new DurableObjectKvStorage(memStorage);
			const live = new Doc();

			// Store some updates
			await store(kvStorage, live, createUpdateFromText("root", "before-commit"));

			// Commit with a doc that represents the combined state
			const commitDoc = await loadDoc(kvStorage);
			await kvStorage.commit(commitDoc);

			// Retrieve again — should see the same content
			const doc = await loadDoc(kvStorage);
			expect(doc.getText("root").toString()).toBe("before-commit");

			// After commit, there should be no incremental updates
			const updateEntries = new Map<string, unknown>();
			for (const [k, v] of data) {
				if (k.startsWith("ydoc:update:")) {
					updateEntries.set(k, v);
				}
			}
			expect(updateEntries.size).toBe(0);
		});

		it("auto-compacts then retrieves correct state", async () => {
			const data = new Map<string, unknown>();

			const memStorage: MockStorage = {
				get: vi.fn(async (key: string) => data.get(key)),
				list: vi.fn(async (options?: { prefix?: string }) => {
					const prefix = options?.prefix ?? "";
					const result = new Map<string, unknown>();
					for (const [k, v] of data) {
						if (k.startsWith(prefix)) {
							result.set(k, v);
						}
					}
					return result;
				}),
				put: vi.fn(async (key: string, value: unknown) => {
					data.set(key, value);
				}),
				delete: vi.fn(async (keys: string[]) => {
					let count = 0;
					for (const key of keys) {
						if (data.delete(key)) count++;
					}
					return count;
				}),
				transaction: vi.fn(
					async (closure: (txn: MockTransaction) => Promise<unknown>) => {
						return closure(memStorage);
					},
				),
			};

			// Very low thresholds to trigger auto-compaction quickly
			const kvStorage = new DurableObjectKvStorage(memStorage, {
				maxUpdates: 3,
			});
			const live = new Doc();

			await store(kvStorage, live, createUpdateFromText("a", "1"));
			await store(kvStorage, live, createUpdateFromText("b", "2"));
			await store(kvStorage, live, createUpdateFromText("c", "3"));
			// Fourth update should trigger compaction (count > 3)
			await store(kvStorage, live, createUpdateFromText("d", "4"));

			const doc = await loadDoc(kvStorage);
			expect(doc.getText("a").toString()).toBe("1");
			expect(doc.getText("b").toString()).toBe("2");
			expect(doc.getText("c").toString()).toBe("3");
			expect(doc.getText("d").toString()).toBe("4");

			// After auto-compaction, the counters should have been reset
			expect(data.get("ydoc:state:meta")).toEqual({
				bytes: 0,
				count: 0,
				snapshotBytes: expect.any(Number),
			});
		});
	});
});
