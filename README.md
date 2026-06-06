# sol-pin

Apify actor for Pinterest. Publishes scheduled pins from Notion to Pinterest and snapshots engagement analytics back into Notion on a graduated schedule.

## What it does

Two modes:

- **post** — reads Content Pieces with Platform = Pinterest, Stage = Scheduled, and a past published date. Resolves the board name to a board ID via Apify KV store, creates the pin, writes Pin ID and permalink back to Notion, sets Stage → Posted. If `new_board` is set on the piece, registers the board in the KV store first.
- **snapshot** — reads posted pins, pulls analytics for the window since the last snapshot (or published date), writes a Post Snapshot row with deltas. Slows down as pins age, stops after 90 days. Note: Pinterest analytics have a 2-day lag — end date is capped to yesterday.

## How it fits

```
Pinterest API
    ↓
sol-pin (this repo)
    ↓ reads/writes
Notion: Content Pieces DB, Post Snapshots DB
    ↓
Agent Run Log (every run)
Apify KV store: pinterest-boards (board name → board ID)
```

Notion helpers and snapshot scheduling come from SolOSDK. Pinterest API calls and token refresh are local to this repo.

## Notion databases

| DB | ID |
|---|---|
| Content Pieces | `345063a81f60806f8797dcedd3027287` |
| Post Snapshots | `339063a81f6080a0a8ddedfcdf34fca7` |

## Environment variables

Set in Apify Console → actor Settings → Environment Variables.

| Variable | What it is |
|---|---|
| `NOTION_ACCESS_TOKEN` | Notion integration token |
| `PINTEREST_ACCESS_TOKEN` | Pinterest OAuth access token (expires 30d) |
| `PINTEREST_REFRESH_TOKEN` | Pinterest OAuth refresh token (expires 60d) |
| `PINTEREST_APP_ID` | Pinterest app ID |
| `PINTEREST_APP_SECRET` | Pinterest app secret |

The actor auto-refreshes the access token on 401 and writes the new token back to the Apify KV store so the next run picks it up.

## Actor input

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | string | `snapshot` | `snapshot`, `post`, `both` (post then snapshot) |

## Board registration

Board names are resolved via the `pinterest-boards` KV store (board name → board ID). To register a new board, set the `new_board` field on the Content Piece to any non-empty value before the post run. The actor fetches the board list from Pinterest, matches by name, saves the ID to KV, and clears the `new_board` field after posting.

## Deploying

```bash
git add -A && git commit -m "..." && git push
# Apify Console → Builds → Start build
```

SolOSDK is installed at build time via `git+https`. Push SolOSDK to GitHub before triggering a build if it changed.

## Notes

- Account is on Pinterest Trial access — pins are only visible to the account owner until Standard access is granted. OAuth screen recording required to upgrade.
- `write_run_log` uses its own Notion write (not `sol.runs.log`) — schema alignment with SolOSDK is a future task.
