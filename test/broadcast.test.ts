import { describe, it, expect } from "vitest";

import { BroadcastBuffer } from "../src/broadcast";

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const frame = (n: number) => new Uint8Array([n]);

/**
 * Read up to `count` values from a reader, giving up after `ms` of no
 * progress.  Returns whatever was read (the read loop is demand-driven,
 * so reading is what drives the consumer's `pull`).
 */
async function readUpTo(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	count: number,
	ms = 200,
): Promise<number[]> {
	const out: number[] = [];
	while (out.length < count) {
		const result = await Promise.race([
			reader.read(),
			delay(ms).then(() => "timeout" as const),
		]);
		if (result === "timeout") break;
		if (result.done) break;
		out.push(result.value[0]);
	}
	return out;
}

// ──────────────────────────────────────────────────────────
// Basic fan-out
// ──────────────────────────────────────────────────────────

describe("BroadcastBuffer fan-out", () => {
	it("delivers initial frames then pushed frames in order", async () => {
		const buf = new BroadcastBuffer();
		const consumer = buf.createConsumer([frame(100)]);
		const reader = consumer.readable.getReader();

		buf.push(frame(1));
		buf.push(frame(2));
		buf.push(frame(3));

		expect(await readUpTo(reader, 4)).toEqual([100, 1, 2, 3]);
	});

	it("delivers the same pushed frames to multiple consumers", async () => {
		const buf = new BroadcastBuffer();
		const a = buf.createConsumer([frame(0xa0)]);
		const b = buf.createConsumer([frame(0xb0)]);
		const ra = a.readable.getReader();
		const rb = b.readable.getReader();

		buf.push(frame(1));
		buf.push(frame(2));

		expect(await readUpTo(ra, 3)).toEqual([0xa0, 1, 2]);
		expect(await readUpTo(rb, 3)).toEqual([0xb0, 1, 2]);
	});

	it("a new consumer does not receive frames pushed before it joined", async () => {
		const buf = new BroadcastBuffer();
		const a = buf.createConsumer([frame(0xa0)]);
		const ra = a.readable.getReader();
		await readUpTo(ra, 1); // drain a's initial frame

		buf.push(frame(1));
		await readUpTo(ra, 1); // a consumes frame 1, advancing the buffer

		// b joins after frame 1 was pushed — it must only see its initial
		// frame and frames pushed from now on, never the historical frame 1.
		const b = buf.createConsumer([frame(0xb0)]);
		const rb = b.readable.getReader();
		buf.push(frame(2));

		expect(await readUpTo(rb, 2)).toEqual([0xb0, 2]);
	});
});

// ──────────────────────────────────────────────────────────
// Backpressure: resync (C1 / C2 / C3)
// ──────────────────────────────────────────────────────────

describe("BroadcastBuffer resync backpressure", () => {
	it("recovers a lagging consumer with a fresh snapshot instead of dropping deltas", async () => {
		const RESYNC = 0xff;
		let resyncCalls = 0;
		const buf = new BroadcastBuffer({
			highWaterMark: 3,
			backpressure: "resync",
			onResync: () => {
				resyncCalls++;
				return [frame(RESYNC)];
			},
		});

		const consumer = buf.createConsumer([frame(0)]);
		const reader = consumer.readable.getReader();

		// Drain the initial frame so the consumer's stream queue fills and
		// it stops pulling — now it can actually fall behind.
		expect(await readUpTo(reader, 1)).toEqual([0]);
		await delay(20);

		// Flood with deltas while nobody is reading.  Exceeding the
		// high-water mark must trigger a resync, not silent delta loss.
		for (let i = 1; i <= 20; i++) buf.push(frame(i));

		expect(resyncCalls).toBeGreaterThan(0);

		// What the consumer reads next must include the resync marker and
		// must NOT be a corrupted gap of dropped deltas.
		const received = await readUpTo(reader, 25);
		expect(received).toContain(RESYNC);
		// It cannot have received every delta (it fell behind by design).
		expect(received.length).toBeLessThan(20);
	});

	it("keeps memory bounded under a flood (buffer is trimmed on push)", async () => {
		const buf = new BroadcastBuffer({
			highWaterMark: 4,
			backpressure: "resync",
			onResync: () => [frame(0xff)],
		});

		const consumer = buf.createConsumer([frame(0)]);
		const reader = consumer.readable.getReader();
		await readUpTo(reader, 1);
		await delay(20);

		for (let i = 0; i < 1000; i++) buf.push(frame(i & 0xff));

		// The internal buffer is private; assert the bound indirectly via
		// bufferedFrameCount (test-only accessor).
		expect(buf.bufferedFrameCount).toBeLessThanOrEqual(4);
	});

	it("a resynced consumer converges to frames pushed after recovery", async () => {
		const RESYNC = 0xff;
		const buf = new BroadcastBuffer({
			highWaterMark: 2,
			backpressure: "resync",
			onResync: () => [frame(RESYNC)],
		});
		const consumer = buf.createConsumer([frame(0)]);
		const reader = consumer.readable.getReader();
		await readUpTo(reader, 1);
		await delay(20);

		// Force a resync.
		for (let i = 1; i <= 10; i++) buf.push(frame(i));
		await delay(20);

		// New frames pushed after the resync must still arrive.
		buf.push(frame(200));
		buf.push(frame(201));

		const received = await readUpTo(reader, 10);
		expect(received).toContain(RESYNC);
		expect(received).toContain(200);
		expect(received).toContain(201);
	});
});

// ──────────────────────────────────────────────────────────
// Backpressure: error
// ──────────────────────────────────────────────────────────

describe("BroadcastBuffer error backpressure", () => {
	it("disconnects a consumer that falls behind", async () => {
		const buf = new BroadcastBuffer({
			highWaterMark: 3,
			backpressure: "error",
		});
		const consumer = buf.createConsumer([frame(0)]);
		const reader = consumer.readable.getReader();
		await readUpTo(reader, 1);
		await delay(20);

		expect(buf.consumerCount).toBe(1);

		for (let i = 1; i <= 20; i++) buf.push(frame(i));

		// The slow consumer is removed and its stream errors.
		expect(buf.consumerCount).toBe(0);
		await expect(reader.read()).rejects.toThrow(/too slow/);
	});
});

// ──────────────────────────────────────────────────────────
// Echo suppression (M1)
// ──────────────────────────────────────────────────────────

describe("BroadcastBuffer echo suppression", () => {
	it("does not echo a frame back to its caught-up originator", async () => {
		const buf = new BroadcastBuffer();
		const a = buf.createConsumer(undefined, "client-a");
		const b = buf.createConsumer(undefined, "client-b");
		const ra = a.readable.getReader();
		const rb = b.readable.getReader();

		// Let both consumers reach the parked/caught-up state.
		await delay(20);

		// Frame originating from client-a: b receives it, a does not.
		buf.push(frame(1), "client-a");
		// A subsequent un-attributed frame reaches everyone.
		buf.push(frame(2));

		expect(await readUpTo(ra, 2)).toEqual([2]);
		expect(await readUpTo(rb, 2)).toEqual([1, 2]);
	});

	it("still delivers to an originator that has fallen behind", async () => {
		const buf = new BroadcastBuffer();
		const a = buf.createConsumer(undefined, "client-a");
		const reader = a.readable.getReader();

		// Do not read — let the stream queue fill so the consumer is not
		// caught up when its own frame arrives.
		await delay(20);
		buf.push(frame(1)); // fills the stream's internal queue
		buf.push(frame(2), "client-a"); // a is behind → not skipped

		// Re-applying an echoed frame is idempotent in Yjs, so delivering
		// it here is acceptable; the important guarantee is no data loss.
		expect(await readUpTo(reader, 2)).toEqual([1, 2]);
	});
});

// ──────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────

describe("BroadcastBuffer lifecycle", () => {
	it("invokes onEmpty when the last consumer is removed", async () => {
		let empty = 0;
		const buf = new BroadcastBuffer({ onEmpty: () => empty++ });

		const a = buf.createConsumer();
		const b = buf.createConsumer();
		expect(buf.consumerCount).toBe(2);

		a.cancel();
		expect(empty).toBe(0);
		b.cancel();
		expect(empty).toBe(1);
	});

	it("drops all buffered frames once no consumers remain", () => {
		const buf = new BroadcastBuffer();
		const a = buf.createConsumer();
		buf.push(frame(1));
		buf.push(frame(2));
		a.cancel();

		expect(buf.consumerCount).toBe(0);
		expect(buf.bufferedFrameCount).toBe(0);
	});
});
