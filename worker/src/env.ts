// Worker bindings contract. KV namespaces are configured in wrangler.jsonc; the string
// values are Wrangler secrets (set in .dev.vars locally, `wrangler secret put` in prod).
// Notion tokens are per-workspace — each Pinterest account maps to one (see account.ts).
export interface Env {
	OAUTH_TOKENS: KVNamespace;
	PINTEREST_BOARDS: KVNamespace;
	SOL_NOTION_ACCESS_TOKEN: string;
	OLIVE_NOTION_ACCESS_TOKEN: string;
	PINTEREST_APP_ID: string;
	PINTEREST_APP_SECRET: string;
}
