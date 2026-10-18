#!/usr/bin/env bash
# Pre-release gate "Authorization watchdog drill" (pre-release-gates.md), automated. Run ON the host, as the user that
# runs the stack, while two clients are in voice:
#
#   HANGAR_LOGIN=<test member> HANGAR_PASSWORD=… ./infra/scripts/gate-watchdog.sh --domain example.com
#
# Stops the API, then checks that the watchdog trips (flag file, "voice signaling CLOSED", every LiveKit room deleted)
# and that the edge answers 503 to signaling with a token that was valid a moment before. Starts the API again and
# checks that access reopens (flag gone, a fresh join's token is admitted). The API is restarted on any exit.
# The account must not use two-step login. Needs curl and python3 (or python).
#
# Local POC rehearsal: ON_HOST="docker exec hangar-poc sh -c" ... --domain hangar.localhost --insecure
# (ON_HOST runs host-side commands; default: this shell.)
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
ON_HOST="${ON_HOST:-sh -c}"
DC="docker compose -f /opt/hangar/infra/compose.prod.yml --env-file /srv/hangar/config/hangar.env"
FLAG=/srv/hangar/watchdog/closed
PY="$(command -v python3 >/dev/null 2>&1 && python3 -c "" 2>/dev/null && echo python3 || echo python)"
TMP="$(mktemp -d)" # honours TMPDIR
JAR="$TMP/cookies"; : > "$JAR"
fails=0
host() { $ON_HOST "$*"; }
cleanup() { host "$DC start api" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
expect() { # expect <description> <wanted> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1 ($3)"; else echo "FAIL $1 (wanted $2, got $3)"; fails=$((fails + 1)); fi
}
json() { "$PY" -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
xsrf() { awk '$6 == "XSRF-TOKEN" { print $7 }' "$JAR" | tail -1; }
api() {
  curl -s $K -b "$JAR" -c "$JAR" -X "$1" "$APP/api/v1$2" -H "Origin: $APP" -H "X-XSRF-TOKEN: $(xsrf)" \
    -H 'Content-Type: application/json' ${3:+--data "$3"} -o "$TMP/body" -w '%{http_code}' --max-time 15 > "$TMP/status"
  cat "$TMP/body"
}
validate() { curl -s $K -o /dev/null -w '%{http_code}' --max-time 5 -H "Origin: $APP" "$RTC/rtc/validate?access_token=$1"; }
rooms() { # LiveKit room count, asked through the watchdog's own admin client on loopback
  host "$DC exec -T auth-watchdog python -I -c 'import sys; sys.path.insert(0, \"/app\"); import watchdog; print(len(watchdog.room_service(\"ListRooms\", {}).get(\"rooms\") or []))'" 2>/dev/null | tr -d '\r'
}
flag() { host "test -f $FLAG && echo closed || echo open" | tr -d '\r'; }
join_token() {
  local channel
  channel="$(api GET "/servers/$SERVER" | json 'next(c["id"] for c in d["channels"] if c["type"] == "voice" and c["permissions"] & 64)')"
  api POST "/channels/$channel/voice/join" "{\"requestId\":\"$("$PY" -c 'import uuid; print(uuid.uuid4())')\"}" | json 'd["token"]'
}
wait_for() { # wait_for <seconds> <command> <wanted> → seconds waited, or "timeout"
  local start=$SECONDS
  while [ $((SECONDS - start)) -le "$1" ]; do
    [ "$(eval "$2")" = "$3" ] && { echo $((SECONDS - start)); return; }
    sleep 3
  done
  echo timeout
}

api GET /auth/csrf > /dev/null
login="$("$PY" -c 'import json,os; print(json.dumps({"login": os.environ["HANGAR_LOGIN"], "password": os.environ["HANGAR_PASSWORD"], "remember": False}))')"
me="$(api POST /auth/login "$login")"
[ "$(cat "$TMP/status")" = 200 ] || { echo "sign-in failed ($(cat "$TMP/status")): $me" >&2; exit 1; }
SERVER="$(echo "$me" | json 'd["servers"][0]["id"]')"

expect "access open before the drill" open "$(flag)"
before="$(rooms)"
[ "${before:-0}" -gt 0 ] && echo "ok   $before voice room(s) active before the drill" || {
  echo "FAIL no active voice room: put two clients in voice first"; exit 1; }
token="$(join_token)"
expect "a fresh token is admitted while healthy" 200 "$(validate "$token")"

echo "...  stopping the API (dc stop api)"
host "$DC stop api" > /dev/null
tripped="$(wait_for 120 flag closed)"
expect "watchdog closes voice after the API stops (≈65 s)" closed "$(flag)"
echo "     tripped after ${tripped} s"
expect "every LiveKit room deleted" 0 "$(sleep 3; rooms)"
expect "watchdog logged the closure" yes "$(host "$DC logs --since 5m auth-watchdog" 2>&1 | grep -q 'voice signaling CLOSED' && echo yes || echo no)"
expect "edge refuses signaling while closed, even with a valid token" 503 "$(validate "$token")"

echo "...  starting the API (dc start api)"
host "$DC start api" > /dev/null
reopened="$(wait_for 180 flag open)"
expect "access reopens once the API is healthy again (≈30 s after)" open "$(flag)"
echo "     reopened ${reopened} s after the start command"
wait_for 60 'api GET /auth/me >/dev/null; cat "$TMP/status"' 200 > /dev/null
expect "the session survives the API restart" 200 "$(cat "$TMP/status")"
expect "a new join is admitted again" 200 "$(validate "$(join_token)")"

echo
if [ "$fails" -eq 0 ]; then echo "authorization watchdog gate passed"; else echo "$fails check(s) failed"; exit 1; fi
