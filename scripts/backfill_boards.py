"""
backfill_boards.py — one-time bootstrap for the pinterest-boards KV store and Notion Board select.

Run once locally (from the sol-pin root) after env vars are loaded:
    python scripts/backfill_boards.py

What it does:
  1. Fetches all Pinterest boards (paginated).
  2. Saves each as sol:{board_name} in the pinterest-boards Apify KV store.
  3. Warns if two boards share the same name (KV can't distinguish by name).
  4. Merges board names into Notion's Board select property on Content Pieces DB
     without wiping existing options.
  5. Prints a summary.

Credentials read from env (set via direnv / .envrc):
  PINTEREST_ACCESS_TOKEN, APIFY_TOKEN, NOTION_ACCESS_TOKEN
"""

import os
import re
import sys
import requests
from apify_client import ApifyClient

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PINTEREST_TOKEN   = os.getenv("PINTEREST_ACCESS_TOKEN")
APIFY_TOKEN       = os.getenv("APIFY_TOKEN")
NOTION_TOKEN      = os.getenv("NOTION_ACCESS_TOKEN")

PIN_BASE_URL      = "https://api.pinterest.com/v5"
KV_STORE_NAME     = "pinterest-boards"
TENANT            = "sol"
CONTENT_PIECES_DB = "345063a81f60806f8797dcedd3027287"

NOTION_HEADERS = {
    "Authorization":  f"Bearer {NOTION_TOKEN}",
    "Content-Type":   "application/json",
    "Notion-Version": "2022-06-28",
}


# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

def check_env():
    missing = [k for k, v in {
        "PINTEREST_ACCESS_TOKEN": PINTEREST_TOKEN,
        "APIFY_TOKEN":            APIFY_TOKEN,
        "NOTION_ACCESS_TOKEN":    NOTION_TOKEN,
    }.items() if not v]
    if missing:
        print(f"ERROR: missing env vars: {', '.join(missing)}")
        print("Load your .envrc or export them manually before running.")
        sys.exit(1)


def check_apify_auth():
    """Verify the Apify token actually works before touching KV."""
    r = requests.get(
        "https://api.apify.com/v2/users/me",
        headers={"Authorization": f"Bearer {APIFY_TOKEN}"},
        timeout=10,
    )
    if r.status_code != 200:
        print(f"ERROR: Apify auth failed ({r.status_code}). Run `apify login` or check APIFY_TOKEN.")
        sys.exit(1)
    username = r.json().get("data", {}).get("username", "?")
    print(f"Apify auth OK — logged in as {username}")


# ---------------------------------------------------------------------------
# Pinterest helpers
# ---------------------------------------------------------------------------

def fetch_all_boards():
    """Fetches all boards via paginated Pinterest API. Returns list of {id, name}."""
    boards = []
    params = {"page_size": 100}
    while True:
        r = requests.get(
            f"{PIN_BASE_URL}/boards",
            headers={"Authorization": f"Bearer {PINTEREST_TOKEN}"},
            params=params,
            timeout=15,
        )
        if r.status_code != 200:
            print(f"ERROR: Pinterest boards fetch failed: {r.status_code} {r.text}")
            sys.exit(1)
        data = r.json()
        page = data.get("items", [])
        boards.extend({"id": b["id"], "name": b["name"]} for b in page)
        bookmark = data.get("bookmark")
        if not bookmark:
            break
        params["bookmark"] = bookmark
    return boards


# ---------------------------------------------------------------------------
# KV helpers
# ---------------------------------------------------------------------------

def _board_kv_key(board_name):
    """Mirrors the sanitizer in main.py — must stay in sync."""
    safe = re.sub(r"[^a-zA-Z0-9!_.\'()-]", '_', board_name)
    return f"{TENANT}.{safe}"


def get_or_create_kv_store(client):
    store = client.key_value_stores().get_or_create(name=KV_STORE_NAME)
    # apify-client ≥2.x returns a dict; older versions return an object
    return store["id"] if isinstance(store, dict) else store.id


def kv_set(client, store_id, key, value):
    client.key_value_store(store_id).set_record(key, value)


# ---------------------------------------------------------------------------
# Notion helpers
# ---------------------------------------------------------------------------

def get_current_board_options():
    """Reads existing select options from the Board property in Content Pieces DB."""
    r = requests.get(
        f"https://api.notion.com/v1/databases/{CONTENT_PIECES_DB}",
        headers=NOTION_HEADERS,
        timeout=15,
    )
    if r.status_code != 200:
        print(f"ERROR: Notion DB fetch failed: {r.status_code} {r.text}")
        sys.exit(1)
    props = r.json().get("properties", {})
    board_prop = props.get("Board", {})
    options = board_prop.get("select", {}).get("options", [])
    return options


def add_board_options_to_notion(new_names, existing_options):
    """Merges new_names into existing select options and writes back. Returns count added."""
    existing_names = {o["name"] for o in existing_options}
    to_add = [n for n in new_names if n not in existing_names]
    if not to_add:
        return 0

    merged = existing_options + [{"name": n} for n in to_add]

    r = requests.patch(
        f"https://api.notion.com/v1/databases/{CONTENT_PIECES_DB}",
        headers=NOTION_HEADERS,
        json={
            "properties": {
                "Board": {
                    "select": {"options": merged}
                }
            }
        },
        timeout=15,
    )
    if r.status_code != 200:
        print(f"ERROR: Notion Board options update failed: {r.status_code} {r.text}")
        sys.exit(1)
    return len(to_add)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    check_env()
    check_apify_auth()

    # Step 1: fetch all Pinterest boards
    print("\nFetching boards from Pinterest...")
    boards = fetch_all_boards()
    print(f"  {len(boards)} board(s) found")

    # Step 2: warn on name collisions
    seen_names = {}
    for b in boards:
        seen_names.setdefault(b["name"], []).append(b["id"])
    for name, ids in seen_names.items():
        if len(ids) > 1:
            print(f"  WARNING: duplicate board name '{name}' → IDs {ids}. "
                  f"KV will store the last one seen; rename one board on Pinterest.")

    # Step 3: write to KV store
    print(f"\nWriting to Apify KV store '{KV_STORE_NAME}' (tenant prefix: {TENANT})...")
    client = ApifyClient(token=APIFY_TOKEN)
    store_id = get_or_create_kv_store(client)

    new_to_kv = 0
    for b in boards:
        kv_key = _board_kv_key(b["name"])
        existing = client.key_value_store(store_id).get_record(kv_key)
        if existing:
            print(f"  skip (exists): {kv_key}")
        else:
            kv_set(client, store_id, kv_key, b["id"])
            print(f"  saved: {kv_key} → {b['id']}")
            new_to_kv += 1

    # Step 4: merge into Notion Board select
    print("\nUpdating Notion Board select options...")
    existing_options = get_current_board_options()
    print(f"  {len(existing_options)} existing option(s) in Notion")
    board_names = [b["name"] for b in boards]
    added_count = add_board_options_to_notion(board_names, existing_options)
    if added_count:
        print(f"  Added {added_count} new option(s)")
    else:
        print("  No new options to add — Notion already has all boards")

    # Step 5: summary
    print("\n=== Summary ===")
    print(f"  Pinterest boards found:    {len(boards)}")
    print(f"  New KV entries written:    {new_to_kv}")
    print(f"  Notion options added:      {added_count}")
    print("\nDone. Existing runs are unaffected — all lookups will hit prefixed keys from now on.")


if __name__ == "__main__":
    main()
