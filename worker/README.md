# sol-pin-worker

Cloudflare Worker port of the `sol-pin` Apify actor. Syncs Pinterest ↔ Notion in two modes,
fired by Cron Triggers:

- **post** — reads Notion Content Pieces with `Stage = Scheduled` and `Scheduled time` due,
  publishes them as Pinterest pins, writes `Post ID` / `Post link` / `Stage = Posted` back.
- **snapshot** — pulls date-range pin analytics on a graduated schedule and writes rows to
  the Post Snapshots DB.

Every run (success or failure) writes a row to the **Agent Run Log** Notion DB.

## Layout

| File | Owns |
|------|------|
| `src/index.ts` | thin entry — `scheduled()` (dispatch on `event.cron`) + `fetch()` manual trigger + run-log try/finally |
| `src/pinterest.ts` | Pinterest API only (token read/refresh, boards, analytics, publish) |
| `src/notion.ts` | Notion API only (queries, page create/update, run-log writer) |
| `src/post.ts` | post-mode orchestration + `new_board` KV registration |
| `src/snapshot.ts` | snapshot-mode orchestration + graduated schedule |
| `src/env.ts` | bindings contract |

## Bindings (`wrangler.jsonc`)

- KV `OAUTH_TOKENS` — reused from `pinterest-oauth-worker`. Key `sol:pinterest_tokens` →
  `{ access_token, refresh_token, expires_in, stored_at }`. The Worker reads from here and,
  on a 401, refreshes and writes the new tokens **back to the same key**.
- KV `PINTEREST_BOARDS` — board-name → board-id map. Key `sol.<sanitized_board_name>` → id.

## Accounts

Each Pinterest account is one entry in `src/account.ts`: its OAuth token state (KV key
prefix), its board-key tenant, and which Notion workspace token it uses. The active account
is `SOL` (token state `sol-test`, Notion token `SOL_NOTION_ACCESS_TOKEN`). Add `olive`
similarly and map a cron to it to run a second account.

## Secrets

Notion tokens are per-workspace. Locally they live in `worker/.dev.vars` (gitignored); in
production set them with `wrangler secret put`:

```sh
wrangler secret put SOL_NOTION_ACCESS_TOKEN
wrangler secret put OLIVE_NOTION_ACCESS_TOKEN
wrangler secret put PINTEREST_APP_ID
wrangler secret put PINTEREST_APP_SECRET
wrangler secret put TRIGGER_SECRET   # gates the manual fetch() trigger
```

Pinterest access/refresh tokens are **not** secrets — they live in `OAUTH_TOKENS` KV under
`<state>:pinterest_tokens` and are refreshed in place on a 401.

## Manual trigger (auth)

Cron runs need nothing. The manual `fetch()` trigger requires `TRIGGER_SECRET`, passed as
`?token=` or the `X-Trigger-Token` header:

```sh
curl "https://sol-pin-worker.big-sol.workers.dev/?mode=snapshot&token=$TRIGGER_SECRET"
```

## Develop

```sh
npm install
wrangler kv namespace create PINTEREST_BOARDS   # paste id into wrangler.jsonc
npm run typecheck
npm run dev:scheduled                            # then curl the /__scheduled endpoint
```

Trigger a mode locally:

```sh
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"   # post
curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"    # snapshot
curl "http://localhost:8787/?mode=post"                       # manual fetch trigger
```

## Deploy

```sh
wrangler deploy
```
