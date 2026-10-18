# Production config templates

Copy this folder to `/srv/hangar/config/` on the host, fill every `CHANGE_ME`, then `chmod 600` the secret files
(`api.env`, `publisher.env`, `watchdog.env`, `backup.env`, `livekit-keys.yaml`, `postgres_password`). Also copy
`infra/livekit.prod.yaml` to `/srv/hangar/config/livekit.yaml` and set `turn.domain`.

| File | Used by | Secret |
|---|---|---|
| `hangar.env` | `docker compose --env-file` (hosts, version, root) | no |
| `api.env` | api, migrate | yes |
| `publisher.env` | sound-publisher | yes |
| `watchdog.env` | auth-watchdog (dedicated LiveKit key) | yes |
| `backup.env` | backup job | yes (rclone remote only) |
| `livekit-keys.yaml` | livekit (`key_file`) | yes |
| `postgres_password` | postgres, backup (compose secret) — single line, no newline | yes |
| `livekit.yaml` | livekit | no |
| `rclone.conf` | backup job | yes |

Never commit filled copies. Generate secrets with `openssl rand -hex 32`.
