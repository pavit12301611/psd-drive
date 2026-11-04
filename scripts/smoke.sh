#!/usr/bin/env bash
# PSDrive smoke test — against the real API, no demo workspace required.
#
#   bash scripts/smoke.sh [base-url]
#
# Creates a throwaway user, connects a local-disk account, then exercises the
# production path end to end: streamed upload, byte-exact download, HTTP Range,
# full-text search, public sharing and API-key uploads.
#
# Needs only bash and curl — no jq, no node.
set -euo pipefail

BASE="${1:-http://localhost:3000}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/cookies.jar"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
val()  { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
num()  { grep -o "\"$1\":[0-9]*" | head -1 | cut -d: -f2; }

echo "PSDrive @ $BASE"

# 1 — health
curl -fsS "$BASE/healthz" | grep -q '"ok":true' && pass "health check" || fail "health check"

# 2 — public instance facts (what the login screen uses)
INSTANCE=$(curl -fsS "$BASE/api/auth/instance")
DEMO_MODE=$(printf '%s' "$INSTANCE" | grep -o '"demoMode":[a-z]*' | cut -d: -f2)
[ -n "$DEMO_MODE" ] && pass "instance endpoint answers (demo mode: $DEMO_MODE)" || fail "instance endpoint"

# 3 — create a throwaway account
EMAIL="smoke-$(date +%s)-$RANDOM@example.test"
REGISTER=$(curl -sS -c "$JAR" -X POST "$BASE/api/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"Smoke Test\",\"email\":\"$EMAIL\",\"password\":\"smoke-test-password\"}" || true)
TOKEN=$(printf '%s' "$REGISTER" | val accessToken)
if [ -z "$TOKEN" ]; then
  echo "  could not register ($REGISTER)"
  echo "  registration may be closed on this instance — set ALLOW_SIGNUP=true or sign in manually."
  exit 1
fi
pass "account created ($EMAIL)"

# 4 — connect a storage account (local disk: no credentials needed)
ADDED=$(curl -fsS -X POST "$BASE/api/accounts/local" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"label":"Smoke disk","quotaGb":1}')
[ -n "$(printf '%s' "$ADDED" | val id)" ] && pass "storage account connected" || fail "connect account"

STATS=$(curl -fsS "$BASE/api/stats" -H "authorization: Bearer $TOKEN")
ACCOUNTS=$(printf '%s' "$STATS" | num accountCount)
[ "${ACCOUNTS:-0}" -ge 1 ] && pass "storage pool reports $ACCOUNTS account(s)" || fail "storage pool"

# 5 — streamed upload (routed automatically)
printf 'hello from curl\n' > "$WORK/hello.txt"
UP=$(curl -fsS -X POST "$BASE/api/uploads?name=hello.txt" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: text/plain' \
  --data-binary @"$WORK/hello.txt")
FILE_ID=$(printf '%s' "$UP" | val id)
[ -n "$FILE_ID" ] && pass "upload stored ($(printf '%s' "$UP" | grep -o '"accountLabel":"[^"]*"' | cut -d'"' -f4))" || fail "upload"

# 6 — the bytes come back byte-for-byte (cookie auth, like a browser download)
curl -fsS -b "$JAR" "$BASE/api/files/download/$FILE_ID" -o "$WORK/hello.out"
cmp -s "$WORK/hello.txt" "$WORK/hello.out" && pass "download matches original" || fail "download mismatch"

# 7 — Range support
curl -fsS -b "$JAR" -H 'Range: bytes=0-4' "$BASE/api/files/content/$FILE_ID" -o "$WORK/slice.txt"
[ "$(cat "$WORK/slice.txt")" = "hello" ] && pass "HTTP range request returns the slice" || fail "range request"

# 8 — instant search
curl -fsS "$BASE/api/files?q=hello" -H "authorization: Bearer $TOKEN" | grep -q 'hello.txt' \
  && pass "full-text search finds the file" || fail "search"

# 9 — public share link, no session at all
SHARE=$(curl -fsS -X POST "$BASE/api/shares" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"fileId\":\"$FILE_ID\"}")
SHARE_TOKEN=$(printf '%s' "$SHARE" | val token)
curl -fsS "$BASE/api/public/$SHARE_TOKEN/download" -o "$WORK/shared.out"
cmp -s "$WORK/hello.txt" "$WORK/shared.out" && pass "public link works without a session" || fail "public share"

# 10 — API key + machine upload
KEY=$(curl -fsS -X POST "$BASE/api/api-keys" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"curl","scopes":["upload","read"]}' | val secret)
curl -fsS -X POST "$BASE/api/v1/files?name=via-api.txt" -H "X-API-Key: $KEY" \
  --data-binary @"$WORK/hello.txt" | grep -q '"id"' && pass "API key upload works" || fail "API upload"

# 11 — bad key is rejected
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/usage" -H 'X-API-Key: psd_wrong')
[ "$CODE" = "401" ] && pass "invalid API key rejected (401)" || fail "api key guard ($CODE)"

# 12 — demo login must not work when demo mode is off
if [ "$DEMO_MODE" = "false" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/demo")
  [ "$CODE" = "401" ] && pass "demo login disabled on a real instance" || fail "demo guard ($CODE)"
fi

echo "All checks passed."
