#!/usr/bin/env bash
# Local POC without a VPS: runs the unmodified production stack (compose.prod.yml, host networking, Caddy layer4,
# forward_auth gate, watchdog) inside a Docker-in-Docker container that plays the VPS, via poc-bootstrap.sh --local.
#
#   ./infra/scripts/poc-local.sh up      # build + start (first run ~10 min), prints the owner invite
#   ./infra/scripts/poc-local.sh down    # stop (data kept in the hangar-poc-* volumes)
#   ./infra/scripts/poc-local.sh invite  # print the current one-time owner invite link
#   ./infra/scripts/poc-local.sh fresh   # wipe data + secrets (keeps built images), start again with a new invite
#   ./infra/scripts/poc-local.sh reset   # delete the POC container and all its volumes (next `up` rebuilds)
#   ./infra/scripts/poc-local.sh dc ...  # docker compose inside the POC, e.g. `dc logs -f api`
#
# Open https://app.hangar.localhost (Chrome/Edge resolve *.localhost to 127.0.0.1). Caddy issues certificates from
# its own local CA: accept the browser warning for app. AND rtc. (visit https://rtc.hangar.localhost once), or trust
# the root printed by `poc-local.sh ca`. Uses host ports 80, 443, 7881/tcp, 7882/udp: the dev LiveKit is stopped.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep container paths as written

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME=hangar-poc
DOMAIN=hangar.localhost
DC="docker compose -f /opt/hangar/infra/compose.prod.yml --env-file /srv/hangar/config/hangar.env"
inside() { docker exec "$NAME" sh -c "$*"; }

up() {
  if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    # Ports 7881/7882 are advertised to browsers as 127.0.0.1: the dev LiveKit must not hold them.
    docker ps --format '{{.Names}}' | grep -E 'hangar-dev-(livekit|sound-publisher)' | xargs -r docker stop >/dev/null
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --privileged --name "$NAME" \
      -p 80:80 -p 443:443 -p 7881:7881 -p 7882:7882/udp \
      -v "$REPO:/opt/hangar:ro" -v hangar-poc-docker:/var/lib/docker -v hangar-poc-srv:/srv/hangar \
      docker:28.5.1-dind >/dev/null
  fi
  echo "waiting for the inner Docker daemon"
  for _ in $(seq 1 60); do inside 'docker info >/dev/null 2>&1' && break; sleep 2; done
  inside 'apk add -q bash openssl git >/dev/null && git config --global --add safe.directory /opt/hangar'
  docker exec "$NAME" bash /opt/hangar/infra/scripts/poc-bootstrap.sh --domain "$DOMAIN" --email ops@example.com --local
  echo
  echo "Open https://app.$DOMAIN (accept the certificate warning for app. and rtc.)"
  echo "Owner invite (first run): ./infra/scripts/poc-local.sh invite"
}

case "${1:-up}" in
  up) up ;;
  down) docker stop "$NAME" >/dev/null && echo stopped ;;
  fresh) # wipe data and secrets but keep built images, then start again with a new owner invite
    docker exec "$NAME" sh -c "$DC --profile release --profile ops down -v --remove-orphans; rm -rf /srv/hangar/*"
    up ;;
  invite) docker exec "$NAME" sh -c "$DC logs api migrate" 2>/dev/null | grep -o "https://app.$DOMAIN/invite/[A-Za-z0-9_-]*" | tail -1 ;;
  reset) docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm hangar-poc-docker hangar-poc-srv >/dev/null 2>&1 || true; echo "POC data deleted" ;;
  dc) shift; docker exec "$NAME" sh -c "$DC $*" ;;
  ca) inside 'cat /srv/hangar/caddy/data/caddy/pki/authorities/local/root.crt' ;;
  *) echo "usage: $0 up|down|invite|fresh|reset|dc <args>|ca" >&2; exit 2 ;;
esac
