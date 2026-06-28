// Worker bindings contract. KV namespaces are configured in wrangler.jsonc;
// the three string values are Wrangler secrets (`wrangler secret put ...`).
export interface Env {
	OAUTH_TOKENS: KVNamespace;
	PINTEREST_BOARDS: KVNamespace;
	NOTION_ACCESS_TOKEN: string;
	PINTEREST_APP_ID: string;
	PINTEREST_APP_SECRET: string;
}
