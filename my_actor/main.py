"""
pinterest_notion_sync.py — Pinterest to Notion Sync (Apify Actor)
Credentials: Set via Apify Actor environment variables:
  PINTEREST_ACCESS_TOKEN  = your Pinterest OAuth access token
  PINTEREST_REFRESH_TOKEN = your Pinterest OAuth refresh token
  PINTEREST_APP_ID        = your Pinterest app ID
  PINTEREST_APP_SECRET    = your Pinterest app secret
  NOTION_ACCESS_TOKEN     = your Notion integration token
"""

import requests
import time
import os
import sys
import json
from datetime import datetime, timezone, timedelta
from apify import Actor
from apify_client import ApifyClient
from sol.notion.core import create_page, query_db, update_page
from sol.utils import should_snapshot

sys.stdout.reconfigure(line_buffering=True)

pinterest_token  = os.getenv("PINTEREST_ACCESS_TOKEN")
refresh_token    = os.getenv("PINTEREST_REFRESH_TOKEN")
app_id           = os.getenv("PINTEREST_APP_ID")
app_secret       = os.getenv("PINTEREST_APP_SECRET")
notion_token     = os.getenv("NOTION_ACCESS_TOKEN")

# --- Notion database IDs ---
CONTENT_PIECES_DB = "345063a81f60806f8797dcedd3027287"
SNAPSHOTS_DB      = "339063a81f6080a0a8ddedfcdf34fca7"

# --- API settings ---
PIN_BASE_URL  = "https://api.pinterest.com/v5"
WRITE_DELAY   = 0.35  # seconds between API calls

# --- Pinterest metrics to pull per pin ---
# Analytics are date-range based, not lifetime — we sum the window each run
PIN_METRICS = "IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,TOTAL_COMMENTS"

# --- Headers for every Notion API request ---
NOTION_HEADERS = {
    "Authorization":  f"Bearer {notion_token}",
    "Content-Type":   "application/json",
    "Notion-Version": "2022-06-28",
}

# --- KV store name for board name → board ID mapping ---
KV_STORE_NAME = "pinterest-boards"


# =============================================================================
# TOKEN MANAGEMENT
# =============================================================================

def refresh_access_token():
    """Exchange refresh token for a new access token. Updates env and KV store."""
    import base64
    creds = base64.b64encode(f"{app_id}:{app_secret}".encode()).decode()
    r = requests.post(
        "https://api.pinterest.com/v5/oauth/token",
        headers={
            "Authorization": f"Basic {creds}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type":    "refresh_token",
            "refresh_token": refresh_token,
        },
    )
    if r.status_code != 200:
        print(f"  Token refresh failed: {r.status_code} {r.text}")
        return None
    data = r.json()
    new_token = data.get("access_token")
    new_refresh = data.get("refresh_token")
    if new_token:
        print("  Token refreshed successfully")
        # Save updated tokens back to Apify KV store so next run picks them up
        client = ApifyClient()
        kv = client.key_value_store(KV_STORE_NAME)
        kv.set_record("access_token", new_token)
        if new_refresh:
            kv.set_record("refresh_token", new_refresh)
    return new_token


# =============================================================================
# PINTEREST API HELPERS
# =============================================================================

def pin_get(endpoint, params=None):  # <- GET request to Pinterest API
    headers = {"Authorization": f"Bearer {pinterest_token}"}
    r = requests.get(f"{PIN_BASE_URL}/{endpoint}", headers=headers, params=params or {})
    if r.status_code == 401:
        print("  Pinterest token expired, refreshing...")
        new_token = refresh_access_token()
        if new_token:
            globals()["pinterest_token"] = new_token
            headers["Authorization"] = f"Bearer {new_token}"
            r = requests.get(f"{PIN_BASE_URL}/{endpoint}", headers=headers, params=params or {})
    if r.status_code != 200:
        print(f"  Pinterest GET error [{endpoint}]: {r.status_code} {r.text}")
        return None
    return r.json()


def pin_post(endpoint, payload):  # <- POST request to Pinterest API
    headers = {
        "Authorization": f"Bearer {pinterest_token}",
        "Content-Type":  "application/json",
    }
    r = requests.post(f"{PIN_BASE_URL}/{endpoint}", headers=headers, json=payload)
    if r.status_code == 401:
        print("  Pinterest token expired, refreshing...")
        new_token = refresh_access_token()
        if new_token:
            globals()["pinterest_token"] = new_token
            headers["Authorization"] = f"Bearer {new_token}"
            r = requests.post(f"{PIN_BASE_URL}/{endpoint}", headers=headers, json=payload)
    if r.status_code not in (200, 201):
        print(f"  Pinterest POST error [{endpoint}]: {r.status_code} {r.text}")
        return None
    return r.json()


def get_board_id(board_name):
    """Looks up board ID from KV store. Returns None if not found."""
    client = ApifyClient()
    try:
        store = client.key_value_stores().get_or_create(name=KV_STORE_NAME)
        store_id = store["id"]
        record = client.key_value_store(store_id).get_record(board_name)
        return record["value"] if record else None
    except Exception as e:
        print(f"  KV read error: {e}")
        return None


def save_board_to_kv(board_name, board_id):
    """Saves a board name → ID mapping to the KV store."""
    client = ApifyClient()
    try:
        store = client.key_value_stores().get_or_create(name=KV_STORE_NAME)
        store_id = store["id"]
        client.key_value_store(store_id).set_record(board_name, board_id)
        print(f"  KV saved: '{board_name}' → {board_id}")
    except Exception as e:
        print(f"  KV write error: {e}")


def resolve_board_id(board_name, new_board_url):
    """
    Resolves a board name to a board ID.
    1. Check KV store — if found, return it
    2. If new_board_url is set, fetch board name from Pinterest API, save to KV, return ID
    3. Otherwise return None (can't post without a board)
    """
    if not board_name:
        return None

    # Check KV store first
    board_id = get_board_id(board_name)
    if board_id:
        return board_id

    # Unknown board — check if new_board_url was provided to register it
    if new_board_url:
        # Extract board ID from URL e.g. https://www.pinterest.com/user/board-name/
        # Pinterest board URLs don't expose the ID directly, so we look it up via API
        print(f"  Unknown board '{board_name}' — fetching from Pinterest API...")
        data = pin_get("boards", {"page_size": 100})
        if data:
            for board in data.get("items", []):
                if board.get("name", "").strip().lower() == board_name.strip().lower():
                    found_id = board["id"]
                    save_board_to_kv(board_name, found_id)
                    return found_id
        print(f"  Board '{board_name}' not found on Pinterest — check the name matches exactly")
    else:
        print(f"  Board '{board_name}' not in KV store and no new_board URL provided — skipping")

    return None


def get_pin_analytics(pin_id, start_date, end_date):
    """
    Pulls analytics for a pin over a date range.
    Pinterest returns daily metrics — we sum them into one window total.
    """
    data = pin_get(
        f"pins/{pin_id}/analytics",
        {
            "start_date":   start_date,
            "end_date":     end_date,
            "metric_types": PIN_METRICS,
        },
    )
    if not data:
        return {}

    # Sum daily metrics across the window
    totals = {}
    daily = data.get("all", {}).get("daily_metrics", [])
    for day in daily:
        if day.get("data_status") != "READY":
            continue
        for metric, val in day.get("metrics", {}).items():
            totals[metric] = totals.get(metric, 0) + (val or 0)
    return totals


def publish_pin(board_id, title, description, media_url, dest_link):
    """Creates a pin on Pinterest."""
    payload = {
        "board_id":    board_id,
        "title":       title[:100],  # Pinterest title limit
        "description": description[:800],  # Pinterest description limit
        "link":        dest_link or "",
        "media_source": {
            "source_type": "image_url",
            "url":         media_url,
        },
    }
    return pin_post("pins", payload)


# =============================================================================
# NOTION HELPERS
# =============================================================================

def get_posted_pins():  # <- gets Pinterest pieces marked Posted with a Pin ID
    pages = query_db(notion_token, CONTENT_PIECES_DB, {
        "and": [
            {"property": "Platform", "select":    {"equals": "Pinterest"}},
            {"property": "Stage",    "status":    {"equals": "Posted"}},
            {"property": "Post ID",  "rich_text": {"is_not_empty": True}},
        ]
    })
    pins = []
    for page in pages:
        props        = page["properties"]
        rt           = props.get("Post ID", {}).get("rich_text", [])
        published    = props.get("Published", {}).get("date", {}).get("start")
        last_shot    = (props.get("Last shot", {}).get("date") or {}).get("start")
        title_blocks = props.get("Piece", {}).get("title", [])

        if rt:
            pins.append({
                "notion_page_id": page["id"],
                "pin_id":         rt[0]["plain_text"],
                "title":          title_blocks[0]["plain_text"] if title_blocks else "Untitled",
                "published":      published,
                "last_shot":      last_shot,
            })
    return pins


def get_scheduled_pins():  # <- gets Pinterest pieces scheduled to post today
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    pages = query_db(notion_token, CONTENT_PIECES_DB, {
        "and": [
            {"property": "Platform",  "select": {"equals": "Pinterest"}},
            {"property": "Stage",     "status": {"equals": "Scheduled"}},
            {"property": "Post ID",   "rich_text": {"is_empty": True}},
            {"property": "Published", "date":   {"on_or_before": today}},
        ]
    })
    pins = []
    for page in pages:
        props        = page["properties"]
        title_blocks = props.get("Piece", {}).get("title", [])
        caption_rt   = props.get("Caption", {}).get("rich_text", [])
        media_link   = props.get("Media link", {}).get("url")
        dest_link    = props.get("Dest. link", {}).get("url")
        board_select = (props.get("Board", {}).get("select") or {}).get("name")
        new_board_rt = props.get("new_board", {}).get("rich_text", [])
        new_board    = new_board_rt[0]["plain_text"] if new_board_rt else None

        title = title_blocks[0]["plain_text"] if title_blocks else "Untitled"

        if not media_link:
            print(f"  Skipping '{title}' — no Media link set")
            continue
        if not board_select:
            print(f"  Skipping '{title}' — no Board selected")
            continue

        pins.append({
            "notion_page_id": page["id"],
            "title":          title,
            "caption":        caption_rt[0]["plain_text"] if caption_rt else "",
            "media_url":      media_link,
            "dest_link":      dest_link,
            "board_name":     board_select,
            "new_board":      new_board,
        })
    return pins


def get_last_snapshot(notion_page_id):  # <- gets previous snapshot values for delta calc
    results = query_db(notion_token, SNAPSHOTS_DB, {
        "property": "Content piece",
        "relation": {"contains": notion_page_id}
    })
    if not results:
        return {}
    last = results[-1]["properties"]
    return {
        "impressions":    last.get("Impressions", {}).get("number") or 0,
        "saves":          last.get("Saves", {}).get("number") or 0,
        "pin_clicks":     last.get("Pin clicks", {}).get("number") or 0,
        "outbound":       last.get("Out clicks", {}).get("number") or 0,
        "comments":       last.get("Comments", {}).get("number") or 0,
    }


def create_snapshot(notion_page_id, pin_id, title, metrics):
    """
    Creates a snapshot page in Notion for a pin.
    Metrics are window totals from Pinterest's date-range analytics.
    Deltas are calculated against the previous snapshot.
    """
    snapshot_title = f"{title} — {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    prev = get_last_snapshot(notion_page_id)

    impressions = metrics.get("IMPRESSION", 0)
    saves       = metrics.get("SAVE", 0)
    pin_clicks  = metrics.get("PIN_CLICK", 0)
    outbound    = metrics.get("OUTBOUND_CLICK", 0)
    comments    = metrics.get("TOTAL_COMMENTS", 0)

    props = {
        "Piece":         {"title":    [{"text": {"content": snapshot_title}}]},
        "Platform":      {"select":   {"name": "Pinterest"}},
        "Content piece": {"relation": [{"id": notion_page_id}]},
        # Metrics
        "Impressions":   {"number": impressions},
        "Saves":         {"number": saves},
        "Pin clicks":    {"number": pin_clicks},
        "Out clicks":    {"number": outbound},
        "Comments":      {"number": comments},
        # Deltas vs previous snapshot
        "impressions_dt": {"number": impressions - prev.get("impressions", 0)},
        "saves_dt":       {"number": saves       - prev.get("saves", 0)},
        "pin_klk_dt":     {"number": pin_clicks  - prev.get("pin_clicks", 0)},
        "out_klk_dt":     {"number": outbound    - prev.get("outbound", 0)},
        "comments_dt":    {"number": comments    - prev.get("comments", 0)},
    }
    page_id = create_page(notion_token, SNAPSHOTS_DB, props)
    return page_id is not None


def write_run_log(status, digest, pages_touched, errors=None, metrics=None, notes=None):
    """Creates a page in the Agent Run Log Notion database after each run."""
    phx = timezone(timedelta(hours=-7))
    now = datetime.now(phx)
    run_title = f"sol-pin run — {now.strftime('%Y-%m-%d %-I:%M%p').lower()}"
    completed_at = now.isoformat()
    props = {
        "Run":           {"title": [{"text": {"content": run_title}}]},
        "Status":        {"select": {"name": status}},
        "Trigger":       {"select": {"name": "Schedule"}},
        "Digest":        {"rich_text": [{"text": {"content": digest}}]},
        "Pages Touched": {"number": pages_touched},
        "Completed at":  {"date": {"start": completed_at}},
    }
    if errors:
        props["Errors"] = {"rich_text": [{"text": {"content": errors}}]}
    if metrics:
        props["Metrics"] = {"rich_text": [{"text": {"content": metrics}}]}
    if notes:
        props["Notes"] = {"rich_text": [{"text": {"content": notes}}]}
    r = requests.post(
        "https://api.notion.com/v1/pages",
        headers=NOTION_HEADERS,
        json={
            "parent": {"database_id": "68f1a012-a784-4da7-9e4b-ea22571f3807"},
            "properties": props,
        },
    )
    if r.status_code == 200:
        print(f"  Run log entry created: {run_title}")
        return True
    print(f"  Failed to write run log: {r.status_code} {r.text}")
    return False


# =============================================================================
# MAIN COMMANDS
# =============================================================================

async def run_snapshot():
    """
    Pulls analytics for all Posted Pinterest pins and creates snapshot pages.
    Uses a date window from last snapshot (or published date) to today.
    """
    print("\n=== PINTEREST SNAPSHOT ===")
    pins = get_posted_pins()
    print(f"  {len(pins)} posted pins found")

    if not pins:
        print("  No posted Pinterest pins found.")
        return

    to_snapshot = [p for p in pins if should_snapshot(p["published"], p["last_shot"])]
    skipped = len(pins) - len(to_snapshot)
    print(f"  {len(to_snapshot)} to snapshot, {skipped} skipped by schedule\n")

    today      = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    success, failed = 0, 0

    for pin in to_snapshot:
        pin_id    = pin["pin_id"]
        title     = pin["title"]
        published = pin["published"]
        last_shot = pin["last_shot"]

        print(f"  {title[:50]}...")

        # Window: from last snapshot date (or published date) to today
        start_date = last_shot[:10] if last_shot else (published[:10] if published else None)
        if not start_date:
            print(f"    No start date — skipping")
            skipped += 1
            continue

        # Pinterest analytics have a 2-day lag — cap end date to yesterday
        yesterday  = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
        if start_date >= yesterday:
            print(f"    Too recent for Pinterest analytics window — skipping")
            skipped += 1
            continue

        metrics = get_pin_analytics(pin_id, start_date, yesterday)
        if not metrics:
            print(f"    No analytics returned")
            skipped += 1
            continue

        if create_snapshot(pin["notion_page_id"], pin_id, title, metrics):
            success += 1
            print(
                f"    impressions={metrics.get('IMPRESSION', 0)} "
                f"saves={metrics.get('SAVE', 0)} "
                f"pin_clicks={metrics.get('PIN_CLICK', 0)} "
                f"outbound={metrics.get('OUTBOUND_CLICK', 0)}"
            )
            update_page(notion_token, pin["notion_page_id"], {
                "Last shot": {"date": {"start": datetime.now(timezone.utc).isoformat()}}
            })
            await Actor.push_data({
                "mode":        "snapshot",
                "title":       title,
                "pin_id":      pin_id,
                "impressions": metrics.get("IMPRESSION", 0),
                "saves":       metrics.get("SAVE", 0),
                "pin_clicks":  metrics.get("PIN_CLICK", 0),
                "outbound":    metrics.get("OUTBOUND_CLICK", 0),
                "comments":    metrics.get("TOTAL_COMMENTS", 0),
            })
        else:
            failed += 1

        time.sleep(WRITE_DELAY)

    await Actor.push_data({
        "mode":   "snapshot_summary",
        "title":  "Run Summary",
        "status": f"✅ {success} snapshotted  ⏭️ {skipped} skipped  ❌ {failed} failed",
    })
    print(f"\n  ✅ {success} snapshotted  ⏭️ {skipped} skipped  ❌ {failed} failed")


async def run_post():
    """
    Posts scheduled Pinterest pins from Notion.
    Handles board KV lookup + new board registration.
    Writes Pin ID, post link, and Stage → Posted back to Notion.
    """
    print("\n=== PINTEREST POST ===")
    pins = get_scheduled_pins()
    print(f"  {len(pins)} pin(s) scheduled to post today\n")

    if not pins:
        print("  Nothing scheduled to post.")
        return

    success, failed = 0, 0

    for pin in pins:
        title      = pin["title"]
        media_url  = pin["media_url"]
        caption    = pin["caption"]
        dest_link  = pin["dest_link"]
        board_name = pin["board_name"]
        new_board  = pin["new_board"]
        page_id    = pin["notion_page_id"]

        print(f"  Posting: {title[:50]}...")

        # Resolve board name → board ID via KV store
        board_id = resolve_board_id(board_name, new_board)
        if not board_id:
            print(f"  No board ID found for '{board_name}' — skipping")
            failed += 1
            continue

        # Post the pin
        result = publish_pin(board_id, title, caption, media_url, dest_link)
        if not result or "id" not in result:
            print(f"  Failed to post '{title}'")
            failed += 1
            time.sleep(WRITE_DELAY)
            continue

        pin_id    = result["id"]
        permalink = f"https://www.pinterest.com/pin/{pin_id}/"

        # Write results back to Notion
        updates = {
            "Stage":     {"status":    {"name": "Posted"}},
            "Post ID":   {"rich_text": [{"text": {"content": pin_id}}]},
            "Post link": {"url": permalink},
            "Published": {"date": {"start": datetime.now(timezone.utc).strftime("%Y-%m-%d")}},
        }
        # Clear new_board field now that it's been registered
        if new_board:
            updates["new_board"] = {"rich_text": []}

        updated = update_page(notion_token, page_id, updates)

        if updated:
            success += 1
            print(f"  Posted ✅  Pin ID: {pin_id}")
        else:
            print(f"  Posted to Pinterest but Notion update failed for '{title}' — update manually")
            failed += 1

        time.sleep(WRITE_DELAY)

        await Actor.push_data({
            "mode":      "post",
            "title":     title,
            "pin_id":    pin_id,
            "board":     board_name,
            "permalink": permalink,
            "status":    "posted",
        })

    print(f"\n  ✅ {success} posted  ❌ {failed} failed")


async def main() -> None:
    async with Actor:
        if not pinterest_token:
            print("ERROR: PINTEREST_ACCESS_TOKEN missing")
            return
        if not notion_token:
            print("ERROR: NOTION_ACCESS_TOKEN missing")
            return

        actor_input = await Actor.get_input() or {}
        mode = actor_input.get("mode", "snapshot")

        error_msg: str | None = None
        try:
            if mode == "both":
                await run_post()
                await run_snapshot()
            elif mode == "snapshot":
                await run_snapshot()
            elif mode == "post":
                await run_post()
            else:
                await Actor.push_data({"mode": "error", "message": f"Unknown mode: '{mode}'"})
                print(f"Unknown mode: '{mode}'. Use snapshot, post, or both.")
        except Exception as exc:
            error_msg = str(exc)
            raise
        finally:
            if notion_token:
                write_run_log(
                    status="Failed" if error_msg else "Success",
                    digest=f"mode={mode}",
                    pages_touched=0,
                    errors=error_msg,
                )