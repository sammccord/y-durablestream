/**
 * Length-prefixed message framing for streaming Yjs protocol messages
 * over TransformStream between Durable Objects.
 *
 * Each frame is encoded as:
 *   [4-byte big-endian length] [payload of that length]
 *
 * This is necessary because a ReadableStream<Uint8Array> can deliver data
 * in arbitrary chunk sizes. Without framing, the receiver cannot determine
 * where one Yjs protocol message ends and the next begins.
 */

const HEADER_SIZE = 4;
const MAX_FRAME_SIZE = 1024 * 1024; // 1MB safety limit

/**
 * Encode a message into a length-prefixed frame.
 *
 * @param message - The raw Yjs protocol message bytes
 * @returns A new Uint8Array with a 4-byte big-endian length header followed by the message
 */
export function encodeFrame(message: Uint8Array): Uint8Array {
	const frame = new Uint8Array(HEADER_SIZE + message.byteLength);
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	view.setUint32(0, message.byteLength, false); // big-endian
	frame.set(message, HEADER_SIZE);
	return frame;
}

/**
 * Encode multiple messages into a single buffer of concatenated frames.
 * More efficient than encoding and concatenating individually when sending
 * an initial burst of messages (e.g. sync step1 + awareness).
 *
 * @param messages - Array of raw Yjs protocol message bytes
 * @returns A single Uint8Array containing all length-prefixed frames
 */
export function encodeFrames(messages: Uint8Array[]): Uint8Array {
	let totalLength = 0;
	for (const msg of messages) {
		totalLength += HEADER_SIZE + msg.byteLength;
	}

	const buffer = new Uint8Array(totalLength);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	let offset = 0;

	for (const msg of messages) {
		view.setUint32(offset, msg.byteLength, false);
		offset += HEADER_SIZE;
		buffer.set(msg, offset);
		offset += msg.byteLength;
	}

	return buffer;
}

/**
 * A stateful decoder that reconstructs complete messages from arbitrarily
 * chunked stream data. Call `push()` with each chunk received from the
 * ReadableStream, and it returns an array of any complete messages
 * that have been fully received.
 *
 * Maintains an internal buffer of partial data between calls.
 *
 * @example
 * ```
 * const decoder = createFrameDecoder();
 * const reader = stream.getReader();
 * while (true) {
 *   const { done, value } = await reader.read();
 *   if (done) break;
 *   const messages = decoder.push(value);
 *   for (const msg of messages) {
 *     handleMessage(msg);
 *   }
 * }
 * ```
 */
export function createFrameDecoder(): FrameDecoder {
	let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

	function push(chunk: Uint8Array): Uint8Array[] {
		// Append new chunk to existing buffer
		if (buffer.byteLength === 0) {
			buffer = chunk;
		} else {
			const combined = new Uint8Array(buffer.byteLength + chunk.byteLength);
			combined.set(buffer, 0);
			combined.set(chunk, buffer.byteLength);
			buffer = combined;
		}

		const messages: Uint8Array[] = [];

		// Extract as many complete frames as possible
		while (buffer.byteLength >= HEADER_SIZE) {
			const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
			const payloadLength = view.getUint32(0, false);

			if (payloadLength > MAX_FRAME_SIZE) {
				throw new FrameDecodeError(
					`Frame payload length ${payloadLength} exceeds maximum of ${MAX_FRAME_SIZE} bytes`
				);
			}

			const frameSize = HEADER_SIZE + payloadLength;
			if (buffer.byteLength < frameSize) {
				// Not enough data yet for the full frame — wait for more
				break;
			}

			// Extract the complete message payload
			const message = buffer.slice(HEADER_SIZE, frameSize);
			messages.push(message);

			// Advance past this frame
			buffer = buffer.slice(frameSize);
		}

		return messages;
	}

	function reset(): void {
		buffer = new Uint8Array(0);
	}

	function bufferedBytes(): number {
		return buffer.byteLength;
	}

	return { push, reset, bufferedBytes };
}

/**
 * The interface returned by `createFrameDecoder()`.
 */
export interface FrameDecoder {
	/**
	 * Push a chunk of data from the stream. Returns an array of complete
	 * message payloads that have been fully received. May return an empty
	 * array if the chunk did not complete any pending frame.
	 *
	 * @param chunk - Raw bytes received from the ReadableStream
	 * @returns Array of complete message payloads (without the length header)
	 */
	push(chunk: Uint8Array): Uint8Array[];

	/**
	 * Reset the decoder's internal buffer. Useful when reconnecting
	 * or cleaning up to avoid processing stale partial data.
	 */
	reset(): void;

	/**
	 * Returns the number of bytes currently buffered (partial frame data
	 * waiting for more bytes). Useful for diagnostics.
	 */
	bufferedBytes(): number;
}

/**
 * Error thrown when the frame decoder encounters invalid data.
 */
export class FrameDecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FrameDecodeError";
	}
}
