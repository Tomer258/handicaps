#!/usr/bin/env bash
# deploy.md §3 automated checks, run from a machine OUTSIDE the host (your laptop, another VPS).
#
#   ./infra/scripts/poc-verify.sh --domain example.com [--host <vps-ip>]
#
# Checks the SPA, that /internal and the LiveKit admin API are not exposed, that signaling without a token is refused,
# and (when nmap is installed and --host is given) that private ports are closed from outside.
# Manual follow-ups: sign in, attachment, voice from two networks (one with UDP blocked), token-free edge logs.
set -uo pipefail

DOMAIN="" HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMAIN" ] || { echo "usage: $0 --domain example.com [--host <vps-ip>]" >&2; exit 2; }
APP="https://app.$DOMAIN" RTC="https://rtc.$DOMAIN"
fails=0
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
expect() { # expect <description> <wanted> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1 ($3)"; else echo "FAIL $1 (wanted $2, got $3)"; fails=$((fails + 1)); fi
}

expect "SPA served"                           200 "$(code "$APP/")"
expect "HTTP redirects to HTTPS"              308 "$(code "http://app.$DOMAIN/")"
expect "/internal blocked on the app host"    404 "$(code "$APP/internal/livekit/admission")"
expect "watchdog status not public"           404 "$(code "$APP/internal/watchdog/reconcile")"
expect "signaling without a token refused"    403 "$(code "$RTC/rtc/validate")"
expect "garbage token refused"                403 "$(code "$RTC/rtc/validate?access_token=not-a-jwt")"
expect "LiveKit Twirp API not exposed"        404 "$(code -X POST "$RTC/twirp/livekit.RoomService/ListRooms")"
expect "rtc host serves nothing else"         404 "$(code "$RTC/")"
expect "API reachable through the edge"       401 "$(code "$APP/api/v1/auth/me")"
hsts="$(curl -sI --max-time 10 "$APP/" | tr -d '\r' | grep -i '^strict-transport-security' || true)"
expect "HSTS header present"                  yes "$([ -n "$hsts" ] && echo yes || echo no)"

if [ -n "$HOST" ] && command -v nmap >/dev/null; then
  open="$(nmap -Pn -p 5349,7880,8080,5432,6789,8443,8090,2019 "$HOST" 2>/dev/null | awk '/\/tcp/ && $2 == "open" {print $1}' | tr '\n' ' ')"
  expect "private TCP ports closed from outside" "" "$open"
elif [ -n "$HOST" ]; then
  echo "skip port scan (install nmap)"
fi

echo
[ "$fails" -eq 0 ] && echo "all automated checks passed" || echo "$fails check(s) failed"
exit "$fails"
