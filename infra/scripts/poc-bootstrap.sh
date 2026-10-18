#!/usr/bin/env bash
# One-command POC install on a fresh VPS (deploy.md §1 steps 4–6 and §2, automated).
#
#   sudo ./infra/scripts/poc-bootstrap.sh --domain example.com --email ops@example.com [--ufw]
#
# Prerequisites (deploy.md §1 steps 1–3): Ubuntu/Debian with Docker Engine + Compose plugin, this repo cloned at
# /opt/hangar, DNS A records app./rtc./turn.<domain> → this host, and the provider firewall per deploy.md §1.3.
# --ufw also applies the host firewall rules (keep your SSH rule!).
#
# Secrets are generated once, written into copies of infra/config.example (the templates stay the source of truth),
# and never printed. Re-running keeps an existing config unless --force-config is given. Backups are NOT configured
# (backup.env keeps its CHANGE_ME values): set them up before inviting real users (backup-restore.md).
#
# Options: --root DIR (default /srv/hangar)   --app-host/--rtc-host/--turn-host H (default app./rtc./turn.<domain>)
#          --config-only (directories + config, no sysctl/firewall/compose)   --force-config
#          --local (no VPS: LiveKit advertises 127.0.0.1 instead of its STUN-detected public IP; used by poc-local.sh)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT=/srv/hangar DOMAIN="" EMAIL="" APP_HOST="" RTC_HOST="" TURN_HOST="" UFW=0 CONFIG_ONLY=0 FORCE=0 LOCAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --app-host) APP_HOST="$2"; shift 2 ;;
    --rtc-host) RTC_HOST="$2"; shift 2 ;;
    --turn-host) TURN_HOST="$2"; shift 2 ;;
    --ufw) UFW=1; shift ;;
    --config-only) CONFIG_ONLY=1; shift ;;
    --force-config) FORCE=1; shift ;;
    --local) LOCAL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || { echo "usage: $0 --domain example.com --email ops@example.com [--ufw]" >&2; exit 2; }
APP_HOST="${APP_HOST:-app.$DOMAIN}" RTC_HOST="${RTC_HOST:-rtc.$DOMAIN}" TURN_HOST="${TURN_HOST:-turn.$DOMAIN}"
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
if [ "$CONFIG_ONLY" -eq 0 ]; then
  docker compose version >/dev/null 2>&1 || { echo "Docker Engine with the Compose plugin is required" >&2; exit 1; }
fi
step() { printf '\n==> %s\n' "$*"; }
secret() { openssl rand -hex 32; }
CFG="$ROOT/config"

step "Directories and ownership ($ROOT)"
mkdir -p "$CFG" "$ROOT"/{data/keys,postgres,caddy/data,caddy/config,backups,watchdog}
mkdir -p "$ROOT"/data/files/{quarantine,spool/jobs,spool/results,sounds,images,attachments}
chown -R 10001:10001 "$ROOT/data"
chown 10003:10003 "$ROOT/watchdog"
chmod 700 "$CFG" "$ROOT/data/keys"
chmod 755 "$ROOT/watchdog"

FILES=(hangar.env api.env publisher.env watchdog.env livekit-keys.yaml livekit.yaml backup.env postgres_password)
present=0
for f in "${FILES[@]}"; do [ -f "$CFG/$f" ] && present=$((present + 1)); done
if [ "$present" -eq "${#FILES[@]}" ] && [ "$FORCE" -eq 0 ]; then
  step "Config exists in $CFG: keeping it (--force-config regenerates every secret)"
elif [ "$present" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
  echo "incomplete config in $CFG ($present of ${#FILES[@]} files). If no data was created with it yet, rerun with" >&2
  echo "--force-config; otherwise restore the missing files (new secrets would not match the existing database)." >&2
  exit 1
else
  step "Generating config in $CFG"
  OUT="$(mktemp -d "$ROOT/.config.XXXXXX")"
  PG="$(secret)" LK="$(secret)" WD="$(secret)" WORKER="$(secret)"
  VERSION="poc-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)"
  hosts() { sed -e "s/app\.example\.com/$APP_HOST/g" -e "s/rtc\.example\.com/$RTC_HOST/g" -e "s/turn\.example\.com/$TURN_HOST/g"; }
  setkv() { sed -E "s|^($1)=.*|\\1=$2|"; }
  EX="$REPO/infra/config.example"

  hosts < "$EX/hangar.env" | setkv HANGAR_VERSION "$VERSION" | setkv HANGAR_ROOT "$ROOT" | setkv ACME_EMAIL "$EMAIL" > "$OUT/hangar.env"
  hosts < "$EX/api.env" \
    | sed -E "s|Password=[^;]*;|Password=$PG;|" \
    | setkv Hangar__LiveKit__ApiSecret "$LK" | setkv Hangar__Soundboard__WorkerKey "$WORKER" > "$OUT/api.env"
  setkv WORKER_KEY "$WORKER" < "$EX/publisher.env" > "$OUT/publisher.env"
  setkv LIVEKIT_API_SECRET "$WD" < "$EX/watchdog.env" > "$OUT/watchdog.env"
  sed -E -e "s|^hangar:.*|hangar: $LK|" -e "s|^watchdog:.*|watchdog: $WD|" < "$EX/livekit-keys.yaml" > "$OUT/livekit-keys.yaml"
  hosts < "$REPO/infra/livekit.prod.yaml" > "$OUT/livekit.yaml"
  if [ "$LOCAL" -eq 1 ]; then
    sed -i -E 's|^(  )use_external_ip: true|\1use_external_ip: false\n\1node_ip: 127.0.0.1|' "$OUT/livekit.yaml"
  fi
  if [ -f "$CFG/backup.env" ]; then cp -p "$CFG/backup.env" "$OUT/backup.env"; else cp "$EX/backup.env" "$OUT/backup.env"; fi
  printf %s "$PG" > "$OUT/postgres_password"
  unset PG LK WD WORKER

  chown root:root "$OUT"/*
  chmod 600 "$OUT"/{api.env,publisher.env,watchdog.env,backup.env,livekit-keys.yaml,postgres_password}
  chmod 644 "$OUT"/{hangar.env,livekit.yaml}
  if grep -l CHANGE_ME "$OUT"/{hangar.env,api.env,publisher.env,watchdog.env,livekit-keys.yaml,livekit.yaml} 2>/dev/null; then
    echo "a CHANGE_ME placeholder survived in the files above: fix the template substitution" >&2; rm -rf "$OUT"; exit 1
  fi
  # Only a complete config is moved into place (a failed run leaves nothing half-written behind).
  for f in "${FILES[@]}"; do rm -rf "${CFG:?}/$f"; mv "$OUT/$f" "$CFG/$f"; done
  rmdir "$OUT"
fi

[ "$CONFIG_ONLY" -eq 1 ] && { step "Config only: done"; exit 0; }

step "Kernel buffers for media"
printf 'net.core.rmem_max=5000000\nnet.core.wmem_max=5000000\n' > /etc/sysctl.d/90-livekit.conf
sysctl -p /etc/sysctl.d/90-livekit.conf >/dev/null

if [ "$UFW" -eq 1 ]; then
  step "Host firewall (ufw)"
  command -v ufw >/dev/null || { apt-get update -q && apt-get install -yq ufw; }
  ufw allow OpenSSH >/dev/null
  for rule in 80/tcp 443/tcp 7881/tcp 7882/udp 3478/udp; do ufw allow "$rule" >/dev/null; done
  ufw deny 5349/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status verbose
fi

dc() { docker compose -f "$REPO/infra/compose.prod.yml" --env-file "$CFG/hangar.env" "$@"; }

step "Building images (first build takes several minutes)"
dc build
dc --profile ops build backup

step "Database and migrations"
dc up -d postgres
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q postgres)")" = healthy ] && break
  sleep 2
done
dc --profile release run --rm migrate

step "Starting the stack"
dc up -d
dc ps

cat <<EOF

Hangar POC is starting at https://$APP_HOST (certificates may take a minute).
  * Owner invite: printed by the migrate step above (first install only). Open it, then clear your scrollback.
  * Verify: docs/runbooks/deploy.md §3. Logs: alias dc='docker compose -f $REPO/infra/compose.prod.yml --env-file $CFG/hangar.env'
  * Before real users: backups (backup-restore.md) and docs/runbooks/pre-release-gates.md.
EOF
