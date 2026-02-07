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
