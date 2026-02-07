import "cloudflare:test";

import type { TestProvider } from "./worker";
import type { TestSubscriber } from "./worker";
import type { TestSqlProvider } from "./worker";
import type { TestSqlSubscriber } from "./worker";

interface CloudflareEnv {
	Y_STREAM_PROVIDER: DurableObjectNamespace<TestProvider>;
	Y_STREAM_SUBSCRIBER: DurableObjectNamespace<TestSubscriber>;
	Y_SQL_PROVIDER: DurableObjectNamespace<TestSqlProvider>;
	Y_SQL_SUBSCRIBER: DurableObjectNamespace<TestSqlSubscriber>;
}

declare module "cloudflare:test" {
	interface ProvidedEnv extends CloudflareEnv {}
}
