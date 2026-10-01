---
"y-durablestream": minor
---

**Breaking:** `YDocStorage` changes so that persistence no longer loses history for providers with `gc: false` and no longer rewrites large documents for small edits.

- `getYDoc(): Promise<Doc>` is replaced by `load(): Promise<Uint8Array | null>`, which returns the persisted state as one update. Combine stored parts with `Y.mergeUpdates`, not by applying them to a temporary `Doc`.
- `storeUpdate(update)` becomes `storeUpdate(update, doc)`. `doc` is the provider's live document; compaction snapshots it instead of rebuilding from storage.
- The built-in backends compact only once stored updates exceed the larger of `maxBytes` and the current snapshot size.

Custom storage backends must rename `getYDoc` to `load`, return bytes, and accept the `doc` argument.
