import "cloudflare:test";

import type { TestProvider } from "./worker";
import type { TestSubscriber } from "./worker";
import type { TestSqlProvider } from "./worker";
import type { TestSqlSubscriber } from "./worker";
import type { TestNotifyProvider } from "./worker";
import type { TestNotifyReceiver } from "./worker";

interface CloudflareEnv {
	Y_STREAM_PROVIDER: DurableObjectNamespace<TestProvider>;
	Y_STREAM_SUBSCRIBER: DurableObjectNamespace<TestSubscriber>;
	Y_SQL_PROVIDER: DurableObjectNamespace<TestSqlProvider>;
	Y_SQL_SUBSCRIBER: DurableObjectNamespace<TestSqlSubscriber>;
	Y_NOTIFY_PROVIDER: DurableObjectNamespace<TestNotifyProvider>;
	Y_NOTIFY_RECEIVER: DurableObjectNamespace<TestNotifyReceiver>;
}

declare module "cloudflare:test" {
	interface ProvidedEnv extends CloudflareEnv {}
}
