#!/bin/sh
# Nightly backup (docs/runbooks/backup-restore.md). Produces ONE encrypted archive:
#   hangar-<UTC timestamp>.tar.age = { db.dump (pg_dump -Fc), files.tar (ready assets), keys.tar (Data Protection),
#                                      config.tar (non-secret config), manifest.txt }
# Encrypted to AGE_RECIPIENTS (public keys only; the private key lives off this host). Optional off-host copy
# with rclone to RCLONE_REMOTE (daily/ + weekly/ retention). Locally keeps only the newest LOCAL_KEEP archives.
set -eu

: "${AGE_RECIPIENTS:?AGE_RECIPIENTS (age public keys, space separated) is required}"
PGHOST="${PGHOST:-127.0.0.1}"; PGPORT="${PGPORT:-5432}"; PGUSER="${PGUSER:-hangar}"; PGDATABASE="${PGDATABASE:-hangar}"
export PGHOST PGPORT PGUSER PGDATABASE
export PGPASSWORD="$(cat /run/secrets/postgres_password)"
LOCAL_KEEP="${LOCAL_KEEP:-2}"
DAILY_DAYS="${DAILY_DAYS:-7}"
WEEKLY_DAYS="${WEEKLY_DAYS:-28}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d /backups/.work-XXXXXX)"
trap 'rm -rf "$work"' EXIT INT TERM

echo "[$stamp] dumping database"
pg_dump --format=custom --no-owner --file "$work/db.dump"

# Ready assets are immutable (new upload = new name), so copying after the dump only adds unreferenced files.
# quarantine/ and spool/ are transient and excluded.
echo "[$stamp] archiving files"
tar -C /data/files -cf "$work/files.tar" --exclude=./quarantine --exclude=./spool .
tar -C /data -cf "$work/keys.tar" keys
tar -C /config -cf "$work/config.tar" --exclude='*.env' --exclude=postgres_password --exclude=livekit-keys.yaml .

{
  echo "created_utc=$stamp"
  echo "hangar_version=${HANGAR_VERSION:-unknown}"
  echo "schema_last_migration=$(psql -Atc 'select max(migration_id) from __ef_migrations_history' 2>/dev/null || echo unknown)"
  echo "postgres=$(psql -Atc 'show server_version')"
  (cd "$work" && sha256sum db.dump files.tar keys.tar config.tar)
} > "$work/manifest.txt"

out="/backups/hangar-$stamp.tar.age"
set -- 
for r in $AGE_RECIPIENTS; do set -- "$@" -r "$r"; done
tar -C "$work" -cf - manifest.txt db.dump files.tar keys.tar config.tar | age "$@" -o "$out.partial"
mv "$out.partial" "$out"
echo "[$stamp] wrote $out ($(du -h "$out" | cut -f1))"

if [ -n "${RCLONE_REMOTE:-}" ]; then
  rclone --config /config/rclone.conf copyto "$out" "$RCLONE_REMOTE/daily/$(basename "$out")"
  # Sunday → also keep a weekly copy.
  if [ "$(date -u +%u)" = "7" ]; then
    rclone --config /config/rclone.conf copyto "$out" "$RCLONE_REMOTE/weekly/$(basename "$out")"
  fi
  rclone --config /config/rclone.conf delete --min-age "${DAILY_DAYS}d" "$RCLONE_REMOTE/daily"
  rclone --config /config/rclone.conf delete --min-age "${WEEKLY_DAYS}d" "$RCLONE_REMOTE/weekly"
  echo "[$stamp] uploaded to $RCLONE_REMOTE"
else
  echo "[$stamp] WARNING: RCLONE_REMOTE not set — this backup exists only on the production disk" >&2
fi

# Small production disk: keep only the newest LOCAL_KEEP archives here.
ls -1t /backups/hangar-*.tar.age 2>/dev/null | tail -n +"$((LOCAL_KEEP + 1))" | xargs -r rm -f
date -u +%s > /backups/last-success
