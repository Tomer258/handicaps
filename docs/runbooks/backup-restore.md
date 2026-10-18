# Backup and restore

Targets (architecture §9): RPO ≤ 24 h, and RTO ≤ 2 h once a replacement host exists. They are not met until a drill
proves them.

## Nightly backup

`dc --profile ops run --rm backup` runs `infra/backup/backup.sh`. It writes one age-encrypted archive containing:

- a `pg_dump -Fc` of the database;
- the ready file store (sounds, images, attachments; quarantine and spool are excluded);
- the Data Protection keys;
- the non-secret config;
- a manifest with checksums, the schema version and the Postgres version.

With `RCLONE_REMOTE` set, the archive is uploaded to `daily/` (kept 7 days) and, on Sundays, also to `weekly/`
(kept 28 days). Locally, only the newest 2 archives are kept.

```cron
# /etc/cron.d/hangar-backup
30 3 * * * root docker compose -f /opt/hangar/infra/compose.prod.yml --env-file /srv/hangar/config/hangar.env --profile ops run --rm backup >> /var/log/hangar-backup.log 2>&1
```

- Encryption key: run `age-keygen -o identity.txt` on an **offline** machine and put only the public key in
  `backup.env`. Keep the identity in two places that are not this VPS, such as a password manager and a printed copy.
- Alert if `/srv/hangar/backups/last-success` is older than 26 h, or if the log shows the `RCLONE_REMOTE not set`
  warning.
- The secrets (`api.env`, `publisher.env`, `livekit-keys.yaml`, `postgres_password`, `rclone.conf`) are deliberately
  left out of the archive. Keep them in the password manager. Restoring without them just means generating new ones,
  which is fine because sessions are expired on restore anyway.

## Restore (drill monthly, or for real)

1. Prepare a new host per deploy.md §1 (same directories and ownership), with config restored from the password
   manager.
2. `dc up -d postgres` (empty data directory).
3. Copy the archive to `/srv/hangar/backups/`, then:

   ```sh
   dc --profile ops run --rm --entrypoint restore.sh \
      -v /root/identity.txt:/identity:ro -v /srv/hangar/data:/data backup /backups/hangar-<stamp>.tar.age
   sudo chown -R 10001:10001 /srv/hangar/data
   ```

   The script verifies checksums and refuses to write into a non-empty database. It restores the database, files and
   keys, then ends every session and voice lease, so everyone signs in again.
4. Start the release that matches `hangar_version` in the manifest (`dc up -d`). Then check that you can log in, that
   message history is there, that an old attachment and an avatar load, that a soundboard sound plays and that
   voice joins.
5. Record the duration and anything surprising at the end of this file.

## Drill log

- 2026-10-18 (local, dev stack): backed up, then restored into an empty database and data directory. Row counts
  were identical (messages, users, file_assets, channel_events), all 15 asset files and the Data Protection key
  came back, and 0 sessions were left active. Not yet drilled on a fresh VM.
