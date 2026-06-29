import { describe, it, expect } from "vitest";

import {
	encodeFrame,
	encodeFrames,
	encodeMessage,
	createFrameDecoder,
	createMessageDecoder,
	DEFAULT_MAX_FRAME_SIZE,
	FrameDecodeError,
} from "../src/protocol";

describe("encodeFrame", () => {
	it("prepends a 4-byte big-endian length header", () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		const frame = encodeFrame(payload);

		expect(frame.byteLength).toBe(4 + 5);

		const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
		expect(view.getUint32(0, false)).toBe(5);
		expect(Array.from(frame.slice(4))).toEqual([1, 2, 3, 4, 5]);
	});

	it("handles an empty payload", () => {
		const payload = new Uint8Array(0);
		const frame = encodeFrame(payload);

		expect(frame.byteLength).toBe(4);

		const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
		expect(view.getUint32(0, false)).toBe(0);
	});

	it("handles a single-byte payload", () => {
		const payload = new Uint8Array([0xff]);
		const frame = encodeFrame(payload);

		expect(frame.byteLength).toBe(5);

		const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
		expect(view.getUint32(0, false)).toBe(1);
		expect(frame[4]).toBe(0xff);
	});

	it("does not mutate the original payload", () => {
		const payload = new Uint8Array([10, 20, 30]);
		const copy = new Uint8Array(payload);
		encodeFrame(payload);

		expect(Array.from(payload)).toEqual(Array.from(copy));
	});
});

describe("encodeFrames", () => {
	it("encodes multiple messages into a single buffer", () => {
		const msg1 = new Uint8Array([1, 2]);
		const msg2 = new Uint8Array([3, 4, 5]);
		const buffer = encodeFrames([msg1, msg2]);

		// frame1: 4 header + 2 payload = 6
		// frame2: 4 header + 3 payload = 7
		expect(buffer.byteLength).toBe(6 + 7);

		const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

		// First frame
		expect(view.getUint32(0, false)).toBe(2);
		expect(Array.from(buffer.slice(4, 6))).toEqual([1, 2]);

		// Second frame
		expect(view.getUint32(6, false)).toBe(3);
		expect(Array.from(buffer.slice(10, 13))).toEqual([3, 4, 5]);
	});

	it("returns an empty buffer for an empty array", () => {
		const buffer = encodeFrames([]);
		expect(buffer.byteLength).toBe(0);
	});

	it("handles a single message identically to encodeFrame", () => {
		const msg = new Uint8Array([10, 20, 30]);
		const single = encodeFrame(msg);
		const multi = encodeFrames([msg]);

		expect(Array.from(multi)).toEqual(Array.from(single));
	});

	it("handles messages with empty payloads", () => {
		const buffer = encodeFrames([new Uint8Array(0), new Uint8Array(0)]);
		expect(buffer.byteLength).toBe(8); // two 4-byte headers, no payload

		const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		expect(view.getUint32(0, false)).toBe(0);
		expect(view.getUint32(4, false)).toBe(0);
	});
});

describe("createFrameDecoder", () => {
	it("decodes a single complete frame from one chunk", () => {
		const decoder = createFrameDecoder();
		const payload = new Uint8Array([10, 20, 30]);
		const frame = encodeFrame(payload);

		const messages = decoder.push(frame);

		expect(messages).toHaveLength(1);
		expect(Array.from(messages[0])).toEqual([10, 20, 30]);
	});

	it("decodes multiple complete frames from one chunk", () => {
		const decoder = createFrameDecoder();
		const buffer = encodeFrames([
			new Uint8Array([1]),
			new Uint8Array([2, 3]),
			new Uint8Array([4, 5, 6]),
		]);

		const messages = decoder.push(buffer);

		expect(messages).toHaveLength(3);
		expect(Array.from(messages[0])).toEqual([1]);
		expect(Array.from(messages[1])).toEqual([2, 3]);
		expect(Array.from(messages[2])).toEqual([4, 5, 6]);
	});

	it("buffers partial header data across chunks", () => {
		const decoder = createFrameDecoder();
		const frame = encodeFrame(new Uint8Array([0xaa, 0xbb]));

		// Send only the first 2 bytes of the 4-byte header
		const partial1 = frame.slice(0, 2);
		const partial2 = frame.slice(2);

		const messages1 = decoder.push(partial1);
		expect(messages1).toHaveLength(0);
		expect(decoder.bufferedBytes()).toBe(2);

		const messages2 = decoder.push(partial2);
		expect(messages2).toHaveLength(1);
		expect(Array.from(messages2[0])).toEqual([0xaa, 0xbb]);
		expect(decoder.bufferedBytes()).toBe(0);
	});

	it("buffers partial payload data across chunks", () => {
		const decoder = createFrameDecoder();
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		const frame = encodeFrame(payload);

		// Send header + partial payload
		const partial1 = frame.slice(0, 6); // 4 header + 2 payload bytes
		const partial2 = frame.slice(6);    // remaining 3 payload bytes

		const messages1 = decoder.push(partial1);
		expect(messages1).toHaveLength(0);
		expect(decoder.bufferedBytes()).toBe(6);

		const messages2 = decoder.push(partial2);
		expect(messages2).toHaveLength(1);
		expect(Array.from(messages2[0])).toEqual([1, 2, 3, 4, 5]);
	});

	it("handles byte-by-byte delivery", () => {
		const decoder = createFrameDecoder();
		const payload = new Uint8Array([42, 43]);
		const frame = encodeFrame(payload);

		const allMessages: Uint8Array[] = [];
		for (let i = 0; i < frame.byteLength; i++) {
			const messages = decoder.push(frame.slice(i, i + 1));
			allMessages.push(...messages);
		}

		expect(allMessages).toHaveLength(1);
		expect(Array.from(allMessages[0])).toEqual([42, 43]);
	});

	it("handles a frame split between two chunks where first chunk contains one full frame and a partial second", () => {
		const decoder = createFrameDecoder();
		const msg1 = new Uint8Array([1, 2]);
		const msg2 = new Uint8Array([3, 4, 5, 6]);
		const combined = encodeFrames([msg1, msg2]);

		// Split: full first frame (6 bytes) + 3 bytes of second frame header+payload
		const chunk1 = combined.slice(0, 9);
		const chunk2 = combined.slice(9);

		const messages1 = decoder.push(chunk1);
		expect(messages1).toHaveLength(1);
		expect(Array.from(messages1[0])).toEqual([1, 2]);

		const messages2 = decoder.push(chunk2);
		expect(messages2).toHaveLength(1);
		expect(Array.from(messages2[0])).toEqual([3, 4, 5, 6]);
	});

	it("decodes zero-length payload frames", () => {
		const decoder = createFrameDecoder();
		const frame = encodeFrame(new Uint8Array(0));

		const messages = decoder.push(frame);

		expect(messages).toHaveLength(1);
		expect(messages[0].byteLength).toBe(0);
	});

	it("returns an empty array when chunk provides no complete frames", () => {
		const decoder = createFrameDecoder();

		// Just 1 byte — not even a full header
		const messages = decoder.push(new Uint8Array([0]));
		expect(messages).toHaveLength(0);
	});

	it("throws FrameDecodeError for payload length exceeding max", () => {
		const decoder = createFrameDecoder();

		// Craft a header claiming 2MB payload (exceeds 1MB limit)
		const header = new Uint8Array(4);
		const view = new DataView(header.buffer);
		view.setUint32(0, 2 * 1024 * 1024, false);

		expect(() => decoder.push(header)).toThrow(FrameDecodeError);
		expect(() =>
			createFrameDecoder().push(header),
		).toThrow(/exceeds maximum/);
	});

	it("honors a custom maxFrameSize (accepts above the 1MB default, rejects beyond)", () => {
		// A ~2MB payload: rejected by the default decoder, accepted at 4MB.
		const payload = new Uint8Array(2 * 1024 * 1024).fill(7);
		const frame = encodeFrame(payload);

		expect(() => createFrameDecoder().push(frame)).toThrow(/exceeds maximum/);

		const big = createFrameDecoder({ maxFrameSize: 4 * 1024 * 1024 });
		const messages = big.push(frame);
		expect(messages).toHaveLength(1);
		expect(messages[0].byteLength).toBe(payload.byteLength);

		// Still bounded: a frame beyond the custom cap throws, citing the cap.
		const header = new Uint8Array(4);
		new DataView(header.buffer).setUint32(0, 5 * 1024 * 1024, false);
		expect(() => createFrameDecoder({ maxFrameSize: 4 * 1024 * 1024 }).push(header)).toThrow(
			/4194304 bytes/,
		);
	});

	it("DEFAULT_MAX_FRAME_SIZE is 1 MB", () => {
		expect(DEFAULT_MAX_FRAME_SIZE).toBe(1024 * 1024);
	});

	it("reset() clears the internal buffer", () => {
		const decoder = createFrameDecoder();

		// Push partial data
		const frame = encodeFrame(new Uint8Array([1, 2, 3]));
		decoder.push(frame.slice(0, 3));
		expect(decoder.bufferedBytes()).toBe(3);

		decoder.reset();
		expect(decoder.bufferedBytes()).toBe(0);

		// After reset, pushing the full frame should work cleanly
		const messages = decoder.push(frame);
		expect(messages).toHaveLength(1);
		expect(Array.from(messages[0])).toEqual([1, 2, 3]);
	});

	it("bufferedBytes() reports correct values", () => {
		const decoder = createFrameDecoder();
		expect(decoder.bufferedBytes()).toBe(0);

		const frame = encodeFrame(new Uint8Array([1, 2, 3, 4, 5]));

		// Push 3 bytes
		decoder.push(frame.slice(0, 3));
		expect(decoder.bufferedBytes()).toBe(3);

		// Push the rest — completes the frame, buffer should be empty
		decoder.push(frame.slice(3));
		expect(decoder.bufferedBytes()).toBe(0);
	});

	it("handles large payloads correctly", () => {
		const decoder = createFrameDecoder();
		const payload = new Uint8Array(65536);
		for (let i = 0; i < payload.length; i++) {
			payload[i] = i % 256;
		}

		const frame = encodeFrame(payload);
		const messages = decoder.push(frame);

		expect(messages).toHaveLength(1);
		expect(messages[0].byteLength).toBe(65536);
		expect(messages[0][0]).toBe(0);
		expect(messages[0][255]).toBe(255);
		expect(messages[0][256]).toBe(0);
	});

	it("round-trips through encode and decode correctly", () => {
		const decoder = createFrameDecoder();
		const originals = [
			new Uint8Array([]),
			new Uint8Array([0]),
			new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
			new Uint8Array(1000).fill(0xfe),
		];

		const encoded = encodeFrames(originals);
		const decoded = decoder.push(encoded);

		expect(decoded).toHaveLength(originals.length);
		for (let i = 0; i < originals.length; i++) {
			expect(Array.from(decoded[i])).toEqual(Array.from(originals[i]));
		}
	});
});

describe("FrameDecodeError", () => {
	it("is an instance of Error", () => {
		const err = new FrameDecodeError("test");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(FrameDecodeError);
	});

	it("has the correct name", () => {
		const err = new FrameDecodeError("test");
		expect(err.name).toBe("FrameDecodeError");
	});

	it("preserves the message", () => {
		const err = new FrameDecodeError("something went wrong");
		expect(err.message).toBe("something went wrong");
	});
});

describe("encodeMessage / createMessageDecoder", () => {
	function bytes(n: number): Uint8Array {
		const u = new Uint8Array(n);
		for (let i = 0; i < n; i++) u[i] = i % 256;
		return u;
	}

	it("round-trips a small (single-frame) message", () => {
		const msg = new Uint8Array([1, 2, 3, 4, 5]);
		const frames = encodeMessage(msg, 1024);
		expect(frames).toHaveLength(1);

		const decoder = createMessageDecoder();
		const out = frames.flatMap((f) => decoder.push(f));
		expect(out).toHaveLength(1);
		expect(Array.from(out[0])).toEqual([1, 2, 3, 4, 5]);
	});

	it("splits a large message into multiple sub-cap frames and reassembles it", () => {
		const msg = bytes(10_000);
		const cap = 1024; // tiny cap forces many parts
		const frames = encodeMessage(msg, cap);
		expect(frames.length).toBeGreaterThan(1);
		// Every produced frame stays within the cap.
		for (const f of frames) expect(f.byteLength).toBeLessThanOrEqual(cap);

		const decoder = createMessageDecoder({ maxFrameSize: cap });
		const out = frames.flatMap((f) => decoder.push(f));
		expect(out).toHaveLength(1);
		expect(out[0].byteLength).toBe(10_000);
		expect(Array.from(out[0])).toEqual(Array.from(msg));
	});

	it("reassembles across arbitrarily-chunked stream delivery (byte-by-byte)", () => {
		const msg = bytes(3000);
		const cap = 256;
		const stream = concat(encodeMessage(msg, cap));

		const decoder = createMessageDecoder({ maxFrameSize: cap });
		const out: Uint8Array[] = [];
		for (let i = 0; i < stream.byteLength; i++) {
			out.push(...decoder.push(stream.slice(i, i + 1)));
		}
		expect(out).toHaveLength(1);
		expect(Array.from(out[0])).toEqual(Array.from(msg));
	});

	it("round-trips an empty message", () => {
		const decoder = createMessageDecoder();
		const out = encodeMessage(new Uint8Array(0)).flatMap((f) => decoder.push(f));
		expect(out).toHaveLength(1);
		expect(out[0].byteLength).toBe(0);
	});

	it("discards an incomplete message when a new one starts (resync-drop robustness)", () => {
		const cap = 64;
		const msgA = bytes(500); // multi-part
		const msgB = bytes(120); // multi-part
		const framesA = encodeMessage(msgA, cap);
		const framesB = encodeMessage(msgB, cap);
		expect(framesA.length).toBeGreaterThan(2);
		expect(framesB.length).toBeGreaterThan(1);

		const decoder = createMessageDecoder({ maxFrameSize: cap });
		// Feed all of A EXCEPT its last frame (simulates a backpressure resync
		// fast-forwarding the consumer past the tail of the in-flight message).
		const out: Uint8Array[] = [];
		for (const f of framesA.slice(0, -1)) out.push(...decoder.push(f));
		expect(out).toHaveLength(0); // A never completes

		// B arrives in full — its index-0 part resets the decoder, A is discarded,
		// and only B is yielded.
		for (const f of framesB) out.push(...decoder.push(f));
		expect(out).toHaveLength(1);
		expect(Array.from(out[0])).toEqual(Array.from(msgB));
	});

	it("still enforces the per-frame cap on each part", () => {
		// A single part claiming > cap (hand-rolled) is rejected by the frame layer.
		const header = new Uint8Array(4);
		new DataView(header.buffer).setUint32(0, 2 * 1024 * 1024, false);
		expect(() => createMessageDecoder().push(header)).toThrow(/exceeds maximum/);
	});
});

function concat(frames: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const f of frames) len += f.byteLength;
	const out = new Uint8Array(len);
	let off = 0;
	for (const f of frames) {
		out.set(f, off);
		off += f.byteLength;
	}
	return out;
}
