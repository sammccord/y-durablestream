import { env } from "cloudflare:test";

import type { YStreamProvider } from "../src/provider";
import type { YStreamProviderOptions } from "../src/types";

type ProviderClass<P extends YStreamProvider> = new (
	ctx: DurableObjectState,
	env: typeof import("cloudflare:test").env,
	options?: YStreamProviderOptions,
) => P;

/**
 * A provider over `state`'s storage whose startup and background work the
 * test can await. Inside `runInDurableObject` the real `blockConcurrencyWhile`
 * defers until the callback returns, so the constructor's load would never
 * run; shadowing it on the state lets the test drive startup directly.
 */
export function harness<P extends YStreamProvider>(
	Provider: ProviderClass<P>,
	state: DurableObjectState,
	options: YStreamProviderOptions = {},
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
