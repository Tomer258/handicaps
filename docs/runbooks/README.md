# Runbooks

Operational procedures for one Hangar installation on a single VPS (`infra/compose.prod.yml`). The reasoning is in
`docs/architecture/security-and-operations.md`; these pages are the steps.

| Runbook | When |
|---|---|
| [deploy.md](deploy.md) | First install and every release |
| [rollback.md](rollback.md) | A release misbehaves |
| [backup-restore.md](backup-restore.md) | Nightly backup setup, monthly restore drill, disaster recovery |
| [key-rotation.md](key-rotation.md) | Rotating LiveKit / worker / database / Data Protection secrets |
| [media-diagnosis.md](media-diagnosis.md) | Voice, video, screen share or soundboard problems |
| [pre-release-gates.md](pre-release-gates.md) | Security and media checks before inviting people |

Conventions: everything lives under `/srv/hangar` (`config/`, `data/`, `postgres/`, `caddy/`, `backups/`).
`dc` below means:

```sh
alias dc='docker compose -f /opt/hangar/infra/compose.prod.yml --env-file /srv/hangar/config/hangar.env'
```

The repository is checked out at `/opt/hangar` at the release tag.
