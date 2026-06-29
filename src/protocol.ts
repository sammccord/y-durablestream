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

/**
 * Default per-frame payload cap. This is a safety guard against a malformed or
 * hostile length header making the decoder allocate unbounded memory — **not** a
 * yjs or Durable Object limit. The full-document initial sync (`SyncStep2`) is a
 * single frame, so this caps the largest syncable document. Trusted DO-to-DO
 * deployments that sync large documents can raise it per-decoder via
 * {@link createFrameDecoder}'s `maxFrameSize` option.
 *
 * @default 1048576 (1 MB)
 */
export const DEFAULT_MAX_FRAME_SIZE = 1024 * 1024;

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
 *
 * @param options - Optional decoder configuration (see {@link FrameDecoderOptions}).
 */
export function createFrameDecoder(options?: FrameDecoderOptions): FrameDecoder {
	const maxFrameSize = options?.maxFrameSize ?? DEFAULT_MAX_FRAME_SIZE;
	let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	// Read position into `buffer`.  Consumed frames advance `offset`
	// instead of reallocating the buffer, so decoding N frames from one
	// chunk is O(N) rather than O(N²).
	let offset = 0;

	function push(chunk: Uint8Array): Uint8Array[] {
		if (offset >= buffer.byteLength) {
			// Everything buffered so far has been consumed — adopt the
			// new chunk directly (zero-copy fast path for whole frames).
			buffer = chunk;
			offset = 0;
		} else {
			// Compact the unconsumed tail and append the new chunk.
			const remaining = buffer.byteLength - offset;
			const combined = new Uint8Array(remaining + chunk.byteLength);
			combined.set(buffer.subarray(offset), 0);
			combined.set(chunk, remaining);
			buffer = combined;
			offset = 0;
		}

		const messages: Uint8Array[] = [];

		// Extract as many complete frames as possible
		while (buffer.byteLength - offset >= HEADER_SIZE) {
			const view = new DataView(
				buffer.buffer,
				buffer.byteOffset + offset,
				buffer.byteLength - offset,
			);
			const payloadLength = view.getUint32(0, false);

			if (payloadLength > maxFrameSize) {
				throw new FrameDecodeError(
					`Frame payload length ${payloadLength} exceeds maximum of ${maxFrameSize} bytes`
				);
			}

			const frameSize = HEADER_SIZE + payloadLength;
			if (buffer.byteLength - offset < frameSize) {
				// Not enough data yet for the full frame — wait for more
				break;
			}

			// Extract the complete message payload and advance past the frame.
			messages.push(buffer.slice(offset + HEADER_SIZE, offset + frameSize));
			offset += frameSize;
		}

		return messages;
	}

	function reset(): void {
		buffer = new Uint8Array(0);
		offset = 0;
	}

	function bufferedBytes(): number {
		return buffer.byteLength - offset;
	}

	return { push, reset, bufferedBytes };
}

/**
 * Options for {@link createFrameDecoder}.
 */
export interface FrameDecoderOptions {
	/**
	 * Maximum decodable frame payload, in bytes. Frames larger than this throw
	 * a {@link FrameDecodeError}. Raise it to sync documents whose full-state
	 * `SyncStep2` exceeds the {@link DEFAULT_MAX_FRAME_SIZE} default.
	 *
	 * @default {@link DEFAULT_MAX_FRAME_SIZE} (1 MB)
	 */
	maxFrameSize?: number;
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
