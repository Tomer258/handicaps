#!/usr/bin/env bash
# Pre-release gate "Session revocation" (pre-release-gates.md), automated. Run from OUTSIDE the host, like poc-verify.sh.
#
#   HANGAR_LOGIN=<user> HANGAR_PASSWORD=<pw> ./infra/scripts/gate-revocation.sh --domain example.com [--insecure]
#   (--insecure: the local POC's internal CA, e.g. --domain hangar.localhost --insecure)
#
# Signs in as a throwaway session (use an account without two-step login, e.g. a test member), joins the first voice
# channel it may join, takes the initial LiveKit token and a server-refreshed one, revokes the session, then replays
# both tokens through the edge on every signaling entry point: /rtc/validate, a fresh /rtc and /rtc/v1 WebSocket
# upgrade, and a resume (reconnect=1). Before revocation the tokens must be admitted; afterwards every attempt must be
# refused, and the revoked cookie must no longer refresh a token. Needs curl and python3 (or python).
set -uo pipefail

DOMAIN="" K=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --insecure) K="-k"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMAIN" ] && [ -n "${HANGAR_LOGIN:-}" ] && [ -n "${HANGAR_PASSWORD:-}" ] || {
  echo "usage: HANGAR_LOGIN=… HANGAR_PASSWORD=… $0 --domain example.com [--insecure]" >&2; exit 2; }
APP="https://app.$DOMAIN" RTC="https://rtc.$DOMAIN"
PY="$(command -v python3 >/dev/null 2>&1 && python3 -c "" 2>/dev/null && echo python3 || echo python)"
TMP="$(mktemp -d)" # honours TMPDIR; trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/cookies"; : > "$JAR"
fails=0
expect() { # expect <description> <wanted> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1 ($3)"; else echo "FAIL $1 (wanted $2, got $3)"; fails=$((fails + 1)); fi
}
json() { "$PY" -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
xsrf() { awk '$6 == "XSRF-TOKEN" { print $7 }' "$JAR" | tail -1; }
# api <method> <path> [json-body] → body on stdout, status in $TMP/status
api() {
  curl -s $K -b "$JAR" -c "$JAR" -X "$1" "$APP/api/v1$2" -H "Origin: $APP" -H "X-XSRF-TOKEN: $(xsrf)" \
    -H 'Content-Type: application/json' ${3:+--data "$3"} -o "$TMP/body" -w '%{http_code}' --max-time 15 > "$TMP/status"
  cat "$TMP/body"
}
# rtc <path+query> [upgrade] → status code of a signaling attempt through the edge (forward_auth → admission)
rtc() {
  local extra=()
  [ "${2:-}" = upgrade ] && extra=(-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13'
    -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | base64)")
  # A successful upgrade keeps the socket open; --max-time ends it and %{http_code} still reports 101.
  curl -s $K -o /dev/null -w '%{http_code}' --max-time 4 -H "Origin: $APP" "${extra[@]}" "$RTC$1" 2>/dev/null
}

api GET /auth/csrf > /dev/null
login="$("$PY" -c 'import json,os; print(json.dumps({"login": os.environ["HANGAR_LOGIN"], "password": os.environ["HANGAR_PASSWORD"], "remember": False}))')"
me="$(api POST /auth/login "$login")"
[ "$(cat "$TMP/status")" = 200 ] || { echo "sign-in failed ($(cat "$TMP/status")): $me" >&2; exit 1; }
if [ "$(echo "$me" | json 'd.get("twoFactorRequired", False)')" = True ]; then
  echo "this account has two-step login on; use one without it for the drill" >&2; exit 1
fi
server="$(echo "$me" | json 'd["servers"][0]["id"]')"
channel="$(api GET "/servers/$server" | json 'next(c["id"] for c in d["channels"] if c["type"] == "voice" and c["permissions"] & 64)')"
[ -n "$channel" ] || { echo "no voice channel this account may join" >&2; exit 1; }
session="$(api GET /auth/sessions | json 'next(s["id"] for s in d if s["current"])')"

grant="$(api POST "/channels/$channel/voice/join" "{\"requestId\":\"$("$PY" -c 'import uuid; print(uuid.uuid4())')\"}")"
expect "join issues a lease" 200 "$(cat "$TMP/status")"
lease="$(echo "$grant" | json 'd["leaseId"]')"; t1="$(echo "$grant" | json 'd["token"]')"
t2="$(api POST "/voice/$lease/token" | json 'd["token"]')"
expect "server refreshes the token" 200 "$(cat "$TMP/status")"
expect "initial token admitted before revocation" 200 "$(rtc "/rtc/validate?access_token=$t1")"
expect "refreshed token admitted before revocation" 200 "$(rtc "/rtc/validate?access_token=$t2")"
# Same upgrade request as below, so its 403 afterwards is the revocation and not a malformed request.
expect "initial token upgrades to a WebSocket before revocation" 101 "$(rtc "/rtc?access_token=$t1&auto_subscribe=1&protocol=16" upgrade)"

api DELETE "/auth/sessions/$session" > /dev/null
expect "session revoked" 204 "$(cat "$TMP/status")"
sleep 1

for name in initial refreshed; do
  t="$t1"; [ "$name" = refreshed ] && t="$t2"
  expect "$name token: /rtc/validate refused"        403 "$(rtc "/rtc/validate?access_token=$t")"
  expect "$name token: /rtc/v1/validate refused"     403 "$(rtc "/rtc/v1/validate?access_token=$t")"
  expect "$name token: fresh /rtc upgrade refused"    403 "$(rtc "/rtc?access_token=$t&auto_subscribe=1&protocol=16" upgrade)"
  expect "$name token: fresh /rtc/v1 upgrade refused" 403 "$(rtc "/rtc/v1?access_token=$t" upgrade)"
  expect "$name token: resume refused"               403 "$(rtc "/rtc?access_token=$t&reconnect=1&sid=PA_drill" upgrade)"
done
api POST "/voice/$lease/token" > /dev/null
expect "revoked cookie cannot refresh a token" 401 "$(cat "$TMP/status")"

echo
if [ "$fails" -eq 0 ]; then echo "session revocation gate passed"; else echo "$fails check(s) failed"; exit 1; fi
