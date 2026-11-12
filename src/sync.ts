/**
 * Yjs sync protocol message construction shared by the provider and the
 * client. Messages here are unframed; see `./protocol` for framing.
 */

import { createEncoder, toUint8Array, writeVarUint } from "lib0/encoding";
import { writeSyncStep1, writeSyncStep2, writeUpdate } from "y-protocols/sync";

import { encodeMessage } from "./protocol";

import type { Doc } from "yjs";

/** Yjs sync protocol outer message type identifier. */
export const MESSAGE_SYNC = 0;

/** y-protocols/sync sub-message type of a SyncStep2. */
export const SYNC_STEP_2 = 1;

/** A sync Update message wrapping one incremental document update. */
export function createSyncUpdateMessage(update: Uint8Array): Uint8Array {
	const encoder = createEncoder();
	writeVarUint(encoder, MESSAGE_SYNC);
	writeUpdate(encoder, update);
	return toUint8Array(encoder);
}

/**
 * The initial sync burst for a (re)connecting subscriber, as frames:
 *
 * 1. **SyncStep1** — `doc`'s state vector. The subscriber answers with a
 *    SyncStep2 carrying whatever `doc` lacks.
 * 2. **SyncStep2** — the content of `doc` the subscriber lacks: everything
 *    when `stateVector` is omitted, otherwise the diff against it.
 *
 * Each message is split into frames of at most `maxFrameSize` bytes.
 */
export function encodeInitialSync(
	doc: Doc,
	maxFrameSize: number,
	stateVector?: Uint8Array,
): Uint8Array[] {
	const step1 = createEncoder();
	writeVarUint(step1, MESSAGE_SYNC);
	writeSyncStep1(step1, doc);

	const step2 = createEncoder();
	writeVarUint(step2, MESSAGE_SYNC);
	writeSyncStep2(step2, doc, stateVector);

	return [
		...encodeMessage(toUint8Array(step1), maxFrameSize),
		...encodeMessage(toUint8Array(step2), maxFrameSize),
	];
}

/**
 * Whether `message` is a SyncStep2 that carries nothing: no structs and no
 * deletions. Sending one costs an RPC and changes nothing.
 */
export function isEmptySyncStep2(message: Uint8Array): boolean {
	// [MESSAGE_SYNC][SYNC_STEP_2][update length = 2][0 struct clients][0 delete-set clients]
	return (
		message.byteLength === 5 &&
		message[0] === MESSAGE_SYNC &&
		message[1] === SYNC_STEP_2 &&
		message[2] === 2 &&
		message[3] === 0 &&
		message[4] === 0
	);
}
