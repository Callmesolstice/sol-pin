import type { Env } from "./env";

// One Sol-managed Pinterest account ties together three things:
//   - tokenState:  OAUTH_TOKENS KV key prefix -> `${tokenState}:pinterest_tokens`
//   - boardTenant: PINTEREST_BOARDS KV key prefix -> `${boardTenant}.<board_name>`
//   - notionToken: the Notion workspace token to read/write for this account
//
// To run a second account (e.g. olive), add a const here and map a cron to it in index.ts.
export interface Account {
	tokenState: string;
	boardTenant: string;
	notionToken: (env: Env) => string;
}

// Active account. "sol-test" is the live token state today; the user will rename it to
// strip "-test" later (only this const changes when they do).
export const SOL: Account = {
	tokenState: "sol-test",
	boardTenant: "sol",
	notionToken: (env) => env.SOL_NOTION_ACCESS_TOKEN,
};
