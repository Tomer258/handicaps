#!/bin/sh
# Restore drill / disaster recovery (docs/runbooks/backup-restore.md). Run on a NEW host with the API stopped:
#   docker compose ... run --rm --entrypoint restore.sh -v /path/to/age-identity.txt:/identity:ro \
#     -v /srv/hangar/data:/data backup /backups/hangar-<stamp>.tar.age
# Restores the database (into an EMPTY database), the file store and the Data Protection keys, and verifies
# checksums. Sessions and voice leases are expired afterwards (everyone signs in again).
set -eu
archive="${1:?usage: restore.sh <archive.tar.age>}"
identity="${AGE_IDENTITY:-/identity}"
PGHOST="${PGHOST:-127.0.0.1}"; PGPORT="${PGPORT:-5432}"; PGUSER="${PGUSER:-hangar}"; PGDATABASE="${PGDATABASE:-hangar}"
export PGHOST PGPORT PGUSER PGDATABASE
export PGPASSWORD="$(cat /run/secrets/postgres_password)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM
age -d -i "$identity" "$archive" | tar -C "$work" -xf -
(cd "$work" && grep -E '^[0-9a-f]{64}  ' manifest.txt | sha256sum -c -)
cat "$work/manifest.txt"

if [ "$(psql -Atc "select count(*) from information_schema.tables where table_schema='public'")" != "0" ]; then
  echo "refusing: database $PGDATABASE is not empty" >&2; exit 1
fi
pg_restore --no-owner --exit-on-error --dbname "$PGDATABASE" "$work/db.dump"

mkdir -p /data/files /data/keys
tar -C /data/files -xf "$work/files.tar"
tar -C /data -xf "$work/keys.tar"
mkdir -p /data/files/quarantine /data/files/spool/jobs /data/files/spool/results

# Restored state must not resurrect live credentials: end every session and voice lease.
psql -v ON_ERROR_STOP=1 -c "update user_sessions set revoked_at = now() where revoked_at is null" \
     -c "update voice_leases set status = 3, end_reason = 'restored' where status <> 3"
echo "restore complete — start the API, then verify login/history/downloads/soundboard (runbook checklist)"
