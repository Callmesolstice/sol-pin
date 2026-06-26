"""
pinterest_reauth.py — get fresh Pinterest OAuth tokens using real API.

Reads credentials from env (via .env or shell). Starts a local callback
server, opens the Pinterest consent screen, exchanges the code, prints tokens.

Usage:
    cd ~/code_projects/solasis-broadcasting/sol-pin
    set -a && source .env && set +a
    .venv/bin/python pinterest_reauth.py
"""

import base64
import os
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

APP_ID     = os.environ["PINTEREST_APP_ID"]
APP_SECRET = os.environ["PINTEREST_APP_SECRET"]

REDIRECT_URI = "http://localhost:8888/callback"
SCOPES       = "boards:read,boards:write,pins:read,pins:write,user_accounts:read"
API_BASE     = "https://api.pinterest.com/v5"

auth_code = None


class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if "code" in params:
            auth_code = params["code"][0]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"<h2>Authorized! Close this tab and return to terminal.</h2>")
        else:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"No code received.")

    def log_message(self, *_):
        pass


auth_url = (
    f"https://www.pinterest.com/oauth/"
    f"?client_id={APP_ID}"
    f"&redirect_uri={urllib.parse.quote(REDIRECT_URI)}"
    f"&response_type=code"
    f"&scope={SCOPES}"
)

print("\nOpening Pinterest authorization page...")
server = HTTPServer(("localhost", 8888), CallbackHandler)
t = threading.Thread(target=server.handle_request)
t.daemon = True
t.start()
webbrowser.open(auth_url)
print("Waiting for Pinterest callback on localhost:8888 (120s timeout)...")
t.join(timeout=120)

if not auth_code:
    raise SystemExit("Timed out — no authorization code received.")

print(f"Got auth code. Exchanging...")

creds = base64.b64encode(f"{APP_ID}:{APP_SECRET}".encode()).decode()
r = requests.post(
    f"{API_BASE}/oauth/token",
    headers={
        "Authorization": f"Basic {creds}",
        "Content-Type": "application/x-www-form-urlencoded",
    },
    data={
        "grant_type":   "authorization_code",
        "code":         auth_code,
        "redirect_uri": REDIRECT_URI,
    },
)

if r.status_code != 200:
    raise SystemExit(f"Token exchange failed: {r.status_code} {r.text}")

tokens = r.json()
access_token  = tokens["access_token"]
refresh_token = tokens.get("refresh_token", "")
expires_in    = tokens.get("expires_in", "?")

# Verify token works
check = requests.get(f"{API_BASE}/user_account",
                     headers={"Authorization": f"Bearer {access_token}"})
username = check.json().get("username", "?") if check.ok else f"check failed {check.status_code}"

print(f"\n{'='*55}")
print(f"  Authenticated as: {username}")
print(f"  Expires in:       {expires_in}s ({int(expires_in)//86400 if str(expires_in).isdigit() else '?'} days)")
print(f"{'='*55}")
print(f"\nNew access token  (update solpinacc):\n  {access_token}")
print(f"\nNew refresh token (update scppref):\n  {refresh_token}")
print(f"\nRun this to update .env and rerun the actor:")
print(f"  cd ~/code_projects/solasis-broadcasting/sol-pin")
print(f"  set -a && source .env && set +a")
