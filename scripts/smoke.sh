#!/usr/bin/env bash
# PSDrive smoke test
#
#   bash scripts/smoke.sh [base-url]
#
# Exercises the real API end to end: login, pool, streamed upload, byte-exact
# download, HTTP Range, search, public sharing and API keys.
# Needs only curl — no jq, no node.
set -euo pipefail
BASE="${1:-http://localhost:3000}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
val()  { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "PSDrive @ $BASE"

# 1 — health
curl -fsS "$BASE/healthz" | grep -q '"ok":true' && pass "health check" || fail "health check"

# 2 — sign in to the demo workspace (cookie jar is used for media/downloads)
LOGIN=$(curl -fsS -c "${TMPDIR:-/tmp}/psdrive-cookies.jar" -X POST "$BASE/api/auth/demo")
TOKEN=$(printf '%s' "$LOGIN" | val accessToken)
[ -n "$TOKEN" ] && pass "demo login (JWT issued)" || fail "demo login"

# 3 — pooled storage
STATS=$(curl -fsS "$BASE/api/stats" -H "authorization: Bearer $TOKEN")
ACCOUNTS=$(printf '%s' "$STATS" | grep -o '"accountCount":[0-9]*' | cut -d: -f2)
[ "${ACCOUNTS:-0}" -ge 1 ] && pass "storage pool reports $ACCOUNTS accounts" || fail "storage pool"

# 4 — streamed upload (auto-routed to an account with room)
echo "hello from curl" > "$WORK/hello.txt"
UP=$(curl -fsS -X POST "$BASE/api/uploads?name=hello.txt" \
  -H "authorization: Bearer $TOKEN" -H "content-type: text/plain" \
  --data-binary @"$WORK/hello.txt")
FILE_ID=$(printf '%s' "$UP" | val id)
[ -n "$FILE_ID" ] && pass "upload stored ($(printf '%s' "$UP" | grep -o '"accountLabel":"[^"]*"' | cut -d'"' -f4))" || fail "upload"

# 5 — the bytes come back byte-for-byte
curl -fsS -b "${TMPDIR:-/tmp}/psdrive-cookies.jar" "$BASE/api/files/download/$FILE_ID" -o "$WORK/hello.out"
cmp -s "$WORK/hello.txt" "$WORK/hello.out" && pass "download matches original" || fail "download mismatch"

# 6 — Range support
RANGE=$(curl -fsS -b "${TMPDIR:-/tmp}/psdrive-cookies.jar" -H "Range: bytes=0-4" -D "$WORK/headers.txt" "$BASE/api/files/content/$FILE_ID" -o "$WORK/slice.txt" || true)
[ "$(cat "$WORK/slice.txt")" = "hello" ] && pass "HTTP range request returns the slice" || fail "range request"

# 7 — instant search
curl -fsS "$BASE/api/files?q=hello" -H "authorization: Bearer $TOKEN" | grep -q 'hello.txt' \
  && pass "full-text search finds the file" || fail "search"

# 8 — public share link, no auth
SHARE=$(curl -fsS -X POST "$BASE/api/shares" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"fileId\":\"$FILE_ID\"}")
SHARE_TOKEN=$(printf '%s' "$SHARE" | val token)
curl -fsS "$BASE/api/public/$SHARE_TOKEN/download" -o "$WORK/shared.out"
cmp -s "$WORK/hello.txt" "$WORK/shared.out" && pass "public link works without a session" || fail "public share"

# 9 — API key + machine upload
KEY=$(curl -fsS -X POST "$BASE/api/api-keys" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"curl","scopes":["upload","read"]}' | val secret)
curl -fsS -X POST "$BASE/api/v1/files?name=via-api.txt" -H "X-API-Key: $KEY" \
  --data-binary @"$WORK/hello.txt" | grep -q '"id"' && pass "API key upload works" || fail "API upload"

# 10 — bad key is rejected
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/usage" -H "X-API-Key: psd_wrong")
[ "$code" = "401" ] && pass "invalid API key rejected (401)" || fail "api key guard ($code)"

echo "All checks passed."
