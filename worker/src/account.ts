import type { Env } from "./env";
import type { NotionDbs } from "./notion";

// One Sol-managed Pinterest account ties together four things:
//   - tokenState:  OAUTH_TOKENS KV key prefix -> `${tokenState}:pinterest_tokens`
//   - boardTenant: PINTEREST_BOARDS KV key prefix -> `${boardTenant}.<board_name>`
//   - notionToken: the Notion workspace token to read/write content for this account
//   - dbs:         the Content Pieces / Post Snapshots database ids in that workspace
//                  (each account has its own Notion workspace)
//
// To run an account, add it to ACCOUNTS below.
export interface Account {
	tokenState: string;
	boardTenant: string;
	notionToken: (env: Env) => string;
	dbs: NotionDbs;
	// Content-piece title property name (workspaces differ: sol "Piece", olive "Title").
	titleProp: string;
}

// sol account. "sol-test" is the live token state today; the user will rename it to
// strip "-test" later (only this const changes when they do).
export const SOL: Account = {
	tokenState: "sol-test",
	boardTenant: "sol",
	notionToken: (env) => env.SOL_NOTION_ACCESS_TOKEN,
	titleProp: "Piece",
	dbs: {
		contentPieces: "345063a81f60806f8797dcedd3027287",
		snapshots: "339063a81f6080a0a8ddedfcdf34fca7",
	},
};

// olive account ("universe olive" workspace). No Post Snapshots DB yet, so olive runs
// post mode only (snapshot mode is skipped while dbs.snapshots is unset).
export const OLIVE: Account = {
	tokenState: "olive",
	boardTenant: "olive",
	notionToken: (env) => env.OLIVE_NOTION_ACCESS_TOKEN,
	titleProp: "Title",
	dbs: {
		contentPieces: "26c633ed-e283-827d-bedd-01f9ba6552e5",
	},
};

// Accounts processed on every scheduled run.
export const ACCOUNTS: Account[] = [SOL, OLIVE];

// The Agent Run Log is the user's personal monitoring layer — one DB that every account
// (and every worker) logs to. It lives in sol's workspace, so it's written with sol's
// token, which has access, regardless of which account produced the run.
export const RUN_LOG = {
	db: "377063a8-1f60-8004-bb99-ec5fcda1082a",
	token: (env: Env) => env.SOL_NOTION_ACCESS_TOKEN,
};
