import { DurableObject } from "cloudflare:workers";
import { Doc, encodeStateAsUpdate, applyUpdate } from "yjs";

import { YStreamProvider } from "../src/provider";
import { YStreamClient } from "../src/client";
import { DurableObjectSqlStorage } from "../src/storage/sql";

import type { YDocStorage } from "../src/storage/types";

interface Env {
	Y_STREAM_PROVIDER: DurableObjectNamespace<TestProvider>;
	Y_STREAM_SUBSCRIBER: DurableObjectNamespace<TestSubscriber>;
	Y_SQL_PROVIDER: DurableObjectNamespace<TestSqlProvider>;
	Y_SQL_SUBSCRIBER: DurableObjectNamespace<TestSqlSubscriber>;
	Y_NOTIFY_PROVIDER: DurableObjectNamespace<TestNotifyProvider>;
	Y_NOTIFY_RECEIVER: DurableObjectNamespace<TestNotifyReceiver>;
}

/**
 * Test provider — just extends YStreamProvider with no customisation.
 * Uses the default DurableObjectKvStorage backend.
 */
export class TestProvider extends YStreamProvider<Env> {}

/**
 * Test provider backed by DurableObjectSqlStorage.
 */
export class TestSqlProvider extends YStreamProvider<Env> {
	protected override createStorage(): YDocStorage {
		return new DurableObjectSqlStorage(this.ctx.storage, {
			maxBytes: this.maxBytes,
			maxUpdates: this.maxUpdates,
		});
	}
}

/**
 * Test subscriber — a Durable Object that uses YStreamClient to
 * synchronise a local Y.Doc with an upstream TestProvider.
 */
export class TestSubscriber extends DurableObject<Env> {
	doc = new Doc();
	client: YStreamClient | null = null;

	async connectToProvider(providerName: string): Promise<void> {
		const stub = this.env.Y_STREAM_PROVIDER.get(
			this.env.Y_STREAM_PROVIDER.idFromName(providerName),
		);
		this.client = new YStreamClient(this.doc, { stub });
		this.ctx.waitUntil(this.client.connect());
	}

	async connectWithInterest(providerName: string, interest: string[]): Promise<void> {
		const stub = this.env.Y_STREAM_PROVIDER.get(
			this.env.Y_STREAM_PROVIDER.idFromName(providerName),
		);
		this.client = new YStreamClient(this.doc, { stub, interest });
		this.ctx.waitUntil(this.client.connect());
	}

	async connectToProviderWithReconnect(providerName: string): Promise<void> {
		const stub = this.env.Y_STREAM_PROVIDER.get(
			this.env.Y_STREAM_PROVIDER.idFromName(providerName),
		);
		this.client = new YStreamClient(this.doc, {
			stub,
			reconnect: { maxRetries: 3, initialDelay: 100 },
		});
		this.ctx.waitUntil(this.client.connect());
	}

	async getDocState(): Promise<Uint8Array> {
		return encodeStateAsUpdate(this.doc);
	}

	async applyLocalUpdate(update: Uint8Array): Promise<void> {
		applyUpdate(this.doc, update);
	}

	async getText(name: string): Promise<string> {
		return this.doc.getText(name).toString();
	}

	async insertText(name: string, index: number, content: string): Promise<void> {
		this.doc.getText(name).insert(index, content);
	}

	async getStatus(): Promise<string> {
		return this.client?.status ?? "no-client";
	}

	async getSynced(): Promise<boolean> {
		return this.client?.synced ?? false;
	}

	async disconnect(): Promise<void> {
		this.client?.disconnect();
		this.client = null;
	}
}

/**
 * Test subscriber that connects to a TestSqlProvider.
 */
export class TestSqlSubscriber extends DurableObject<Env> {
	doc = new Doc();
	client: YStreamClient | null = null;

	async connectToProvider(providerName: string): Promise<void> {
		const stub = this.env.Y_SQL_PROVIDER.get(
			this.env.Y_SQL_PROVIDER.idFromName(providerName),
		);
		this.client = new YStreamClient(this.doc, { stub });
		this.ctx.waitUntil(this.client.connect());
	}

	async getDocState(): Promise<Uint8Array> {
		return encodeStateAsUpdate(this.doc);
	}

	async getText(name: string): Promise<string> {
		return this.doc.getText(name).toString();
	}

	async insertText(name: string, index: number, content: string): Promise<void> {
		this.doc.getText(name).insert(index, content);
	}

	async getStatus(): Promise<string> {
		return this.client?.status ?? "no-client";
	}

	async getSynced(): Promise<boolean> {
		return this.client?.synced ?? false;
	}

	async disconnect(): Promise<void> {
		this.client?.disconnect();
		this.client = null;
	}
}

/**
 * Test provider exercising the notify-push registry. Overrides
 * {@link YStreamProvider.pushToSubscriber} to RPC a {@link TestNotifyReceiver}
 * DO (resolved by `address.name`) with the raw update — the app-specific
 * delivery the base provider leaves abstract.
 */
export class TestNotifyProvider extends YStreamProvider<Env> {
	protected override pushToSubscriber(address: unknown, update: Uint8Array): void {
		const { name } = address as { name: string };
		const receiver = this.env.Y_NOTIFY_RECEIVER.get(
			this.env.Y_NOTIFY_RECEIVER.idFromName(name),
		);
		this.ctx.waitUntil(receiver.onPush(update));
	}
}

/**
 * Test receiver — a Durable Object that registers for notify-push (no open
 * stream) and applies pushed updates to its local doc. Also exercises
 * {@link YStreamClient.syncOnce}. Registers under a `clientId` equal to its own
 * `idFromName` name, so the provider's `pushToSubscriber` can route back to it.
 */
export class TestNotifyReceiver extends DurableObject<Env> {
	doc = new Doc();
	client: YStreamClient | null = null;

	private providerStub(name: string) {
		return this.env.Y_NOTIFY_PROVIDER.get(this.env.Y_NOTIFY_PROVIDER.idFromName(name));
	}

	async register(providerName: string, clientId: string): Promise<void> {
		await this.providerStub(providerName).register(clientId, { name: clientId });
	}

	async deregister(providerName: string, clientId: string): Promise<void> {
		await this.providerStub(providerName).deregister(clientId);
	}

	/** Apply an update delivered via the provider's notify-push path. */
	async onPush(update: Uint8Array): Promise<void> {
		applyUpdate(this.doc, update);
	}

	/** One-shot bidirectional sync (no persistent stream). */
	async syncOnceWith(providerName: string): Promise<void> {
		this.client = new YStreamClient(this.doc, { stub: this.providerStub(providerName) });
		await this.client.syncOnce();
	}

	async insertText(field: string, index: number, content: string): Promise<void> {
		this.doc.getText(field).insert(index, content);
	}

	async getText(field: string): Promise<string> {
		return this.doc.getText(field).toString();
	}

	async getStatus(): Promise<string> {
		return this.client?.status ?? "no-client";
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Helper to resolve a provider/subscriber namespace from the path prefix
		const isSql = url.pathname.startsWith("/sql-");

		switch (url.pathname) {
			// ── Provider endpoints ──────────────────────────────

			case "/provider/get-doc":
			case "/sql-provider/get-doc": {
				const name = url.searchParams.get("name");
				if (!name) return new Response("Missing name", { status: 400 });
				const ns = isSql ? env.Y_SQL_PROVIDER : env.Y_STREAM_PROVIDER;
				const id = ns.idFromName(name);
				const stub = ns.get(id);
				const state = await stub.getYDoc();
				return new Response(state, {
					headers: { "Content-Type": "application/octet-stream" },
				});
			}

			case "/provider/apply-update":
			case "/sql-provider/apply-update": {
				const name = url.searchParams.get("name");
				if (!name) return new Response("Missing name", { status: 400 });
				const ns = isSql ? env.Y_SQL_PROVIDER : env.Y_STREAM_PROVIDER;
				const id = ns.idFromName(name);
				const stub = ns.get(id);
				const buffer = await request.arrayBuffer();
				await stub.applyUpdate(new Uint8Array(buffer));
				return new Response("OK");
			}

			// ── Subscriber endpoints ────────────────────────────

			case "/subscriber/connect":
			case "/sql-subscriber/connect": {
				const name = url.searchParams.get("name");
				const provider = url.searchParams.get("provider");
				if (!name || !provider) {
					return new Response("Missing name or provider", { status: 400 });
				}
				const subNs = isSql ? env.Y_SQL_SUBSCRIBER : env.Y_STREAM_SUBSCRIBER;
				const id = subNs.idFromName(name);
				const stub = subNs.get(id);
				await stub.connectToProvider(provider);
				return new Response("Connected");
			}

			case "/subscriber/get-text":
			case "/sql-subscriber/get-text": {
				const name = url.searchParams.get("name");
				const field = url.searchParams.get("field") ?? "root";
				if (!name) return new Response("Missing name", { status: 400 });
				const subNs = isSql ? env.Y_SQL_SUBSCRIBER : env.Y_STREAM_SUBSCRIBER;
				const id = subNs.idFromName(name);
				const stub = subNs.get(id);
				const text = await stub.getText(field);
				return new Response(text);
			}

			case "/subscriber/insert-text":
			case "/sql-subscriber/insert-text": {
				const name = url.searchParams.get("name");
				const field = url.searchParams.get("field") ?? "root";
				const content = url.searchParams.get("content") ?? "";
				const index = parseInt(url.searchParams.get("index") ?? "0", 10);
				if (!name) return new Response("Missing name", { status: 400 });
				const subNs = isSql ? env.Y_SQL_SUBSCRIBER : env.Y_STREAM_SUBSCRIBER;
				const id = subNs.idFromName(name);
				const stub = subNs.get(id);
				await stub.insertText(field, index, content);
				return new Response("OK");
			}

			case "/subscriber/status":
			case "/sql-subscriber/status": {
				const name = url.searchParams.get("name");
				if (!name) return new Response("Missing name", { status: 400 });
				const subNs = isSql ? env.Y_SQL_SUBSCRIBER : env.Y_STREAM_SUBSCRIBER;
				const id = subNs.idFromName(name);
				const stub = subNs.get(id);
				const status = await stub.getStatus();
				const synced = await stub.getSynced();
				return Response.json({ status, synced });
			}

			case "/subscriber/disconnect":
			case "/sql-subscriber/disconnect": {
				const name = url.searchParams.get("name");
				if (!name) return new Response("Missing name", { status: 400 });
				const subNs = isSql ? env.Y_SQL_SUBSCRIBER : env.Y_STREAM_SUBSCRIBER;
				const id = subNs.idFromName(name);
				const stub = subNs.get(id);
				await stub.disconnect();
				return new Response("Disconnected");
			}

			default:
				return new Response("Not found", { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;
