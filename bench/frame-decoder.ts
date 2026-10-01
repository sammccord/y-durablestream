// Usage: node --experimental-strip-types bench/frame-decoder.ts [frameBytes] [chunkBytes]
import { createFrameDecoder, encodeFrame } from "../src/protocol.ts";
const size = Number(process.argv[2] ?? 8 * 1024 * 1024);
const chunk = Number(process.argv[3] ?? 16 * 1024);
const payload = new Uint8Array(size).map((_, i) => i & 0xff);
const frame = encodeFrame(payload);
const decoder = createFrameDecoder({ maxFrameSize: size });
const t0 = performance.now();
let out: Uint8Array[] = [];
for (let i = 0; i < frame.byteLength; i += chunk) out.push(...decoder.push(frame.subarray(i, i + chunk)));
const ms = performance.now() - t0;
const ok = out.length === 1 && out[0].byteLength === size && out[0][size - 1] === ((size - 1) & 0xff);
console.log(JSON.stringify({ sizeMB: size / 2 ** 20, chunkKB: chunk / 1024, ms: Math.round(ms), ok }));
