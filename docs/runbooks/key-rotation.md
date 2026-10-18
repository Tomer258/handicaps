# Key rotation

Generate new secrets with `openssl rand -hex 32`.

## LiveKit API key and secret (`livekit-keys.yaml`, `api.env`)

1. Add a new key name to `livekit-keys.yaml` and keep the old one. Restart `livekit` (this drops calls, so schedule
   it).
2. Switch `Hangar__LiveKit__ApiKey` / `Hangar__LiveKit__ApiSecret` and `webhook.api_key` in `livekit.yaml` to the new
   name, then `dc up -d api livekit`.
3. Wait longer than the token lifetime plus the reconnect window (1 h is plenty).
4. Remove the old key and restart `livekit` again during a quiet period.

## Soundboard worker key (`api.env`, `publisher.env`)

Change both files, then `dc up -d api sound-publisher`. The soundboard is unavailable for a few seconds; sounds in
flight fail and are never replayed.

## Postgres password (`postgres_password`, `api.env`)

1. `docker exec -it hangar-postgres-1 psql -U hangar -c "ALTER ROLE hangar PASSWORD 'new-password'"`
2. Update both files, then `dc up -d api`.
3. Run a backup to confirm the job still authenticates.

## Data Protection keys (`/srv/hangar/data/keys`)

ASP.NET rotates them automatically (every 90 days) and keeps the old ones for decryption. Deleting the folder signs
everyone out and invalidates antiforgery tokens. The folder is in the nightly archive. Keys are stored unencrypted at
rest (the API logs a warning about this at startup); the folder is mode 700 and owned by uid 10001.

## Backup age key (offline)

Generate a new identity and add its public key to `AGE_RECIPIENTS` (space separated). Keep the old recipient until
every archive encrypted to it has expired, then drop it.

## TLS certificates (`/srv/hangar/caddy/data`)

Caddy renews them automatically via HTTP-01. Alert if any certificate expires in fewer than 14 days.

## After a compromise

Revoke every session:

```sql
update user_sessions set revoked_at = now() where revoked_at is null;
```

The admission gate then refuses those users' voice reconnects, and the reconciler removes their LiveKit
participants. Then rotate the secrets above that could have leaked.
