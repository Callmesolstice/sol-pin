#!/usr/bin/env python3
"""
Quick one-off test: does a Notion 'Files & media' property hand back
a real, fetchable image URL? No copy-pasting the signed URL anywhere,
this fetches it the same breath it reads it, same as the real actor will.

Usage:
    python3 test_notion_image_url.py <page_id>

<page_id> is the long ID in your test page's URL, dashes or no dashes
both work, e.g. from https://notion.so/My-Page-2bb063a81f6080728c26...
the id is 2bb063a81f6080728c26...
"""
import os
import sys
import requests

NOTION_TOKEN = (
    os.environ.get("NOTION_ACCESS_TOKEN")
    or os.environ.get("notion_access_token")
    or os.environ.get("solinotion")
)
NOTION_VERSION = "2026-03-11"


def main():
    if not NOTION_TOKEN:
        sys.exit(
            "No Notion token found in env (checked NOTION_ACCESS_TOKEN, "
            "notion_access_token, solinotion). Export one and try again, e.g.:\n"
            "  export NOTION_ACCESS_TOKEN=ntn_xxx"
        )
    if len(sys.argv) < 2:
        sys.exit("Usage: python3 test_notion_image_url.py <page_id>")

    page_id = sys.argv[1]

    page = requests.get(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers={
            "Authorization": f"Bearer {NOTION_TOKEN}",
            "Notion-Version": NOTION_VERSION,
        },
    ).json()

    if "properties" not in page:
        sys.exit(f"Couldn't read that page, Notion said:\n{page}")

    file_props = {
        name: prop
        for name, prop in page["properties"].items()
        if prop.get("type") == "files" and prop.get("files")
    }

    if not file_props:
        sys.exit("No files found on that page. Did you attach the test image?")

    for prop_name, prop in file_props.items():
        for f in prop["files"]:
            file_url = f["file"]["url"]
            print(f"\n[{prop_name}] {f['name']}")
            print(f"  expires: {f['file']['expiry_time']}")

            # fetched right now, same script, no manual paste involved
            resp = requests.get(file_url, stream=True)
            content_type = resp.headers.get("content-type")
            print(f"  status: {resp.status_code}, content-type: {content_type}")

            if resp.status_code == 200 and content_type and content_type.startswith("image/"):
                print("  -> real, fetchable image. mechanism works.")
            else:
                print("  -> something's off, check status/content-type above.")


if __name__ == "__main__":
    main()
