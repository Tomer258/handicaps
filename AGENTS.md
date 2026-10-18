# AGENTS.md — Hangar

Instructions for coding agents (Codex, Claude Code, others) working in this repository. `CLAUDE.md` holds the same
boundaries; the architecture in `docs/architecture/` is normative.

## Boundaries

- Work only inside this repository folder. Temporary files go in `./.tmp/` (git-ignored); tool caches live in `./.cache/`.
  Install nothing globally.
- Commit after each verified slice. **Never push** unless the user explicitly asks in that session.
- Never commit secrets, filled config copies (`infra/secrets/`, `*.env` outside `infra/config.example/`), `.data/`,
  or live invitation links.
- One bounded vertical slice at a time. Do not add Redis, a state library, a new runtime or a new service without a
  concrete need recorded in `.claude/memory/DECISIONS.md` (or a superseding ADR).
- Do not remove auth, the admission gate or file validation to make a demo easier. Do not replace Angular with
  React-based LiveKit components.
- Session state and handoff: `.claude/memory/HEARTBEAT.md` (status, next step, verified commands) and `DECISIONS.md`.

## Layout

| Path | Content |
|---|---|
| `apps/web/` | Angular 21 (standalone, signals, OnPush). Design CSS ported from `docs/design/Main.dc.html` |
| `apps/api/` | ASP.NET Core 10: `Hangar.Api` (host, endpoints, SignalR, hosted services), `Hangar.Core` (modules, EF Core/Npgsql), `tests/Hangar.Tests` |
| `workers/asset-validator/` | ffmpeg validation/normalization of uploads; no network, no secrets |
| `workers/sound-publisher/` | Publish-only LiveKit participant for the soundboard |
| `infra/` | `compose.dev.yml`, `compose.prod.yml`, LiveKit configs, `caddy/` (edge image + Caddyfile), `backup/`, `config.example/` |
| `tests/e2e/scripts/` | Playwright smoke scripts against the running dev stack |
| `docs/runbooks/` | Deploy, rollback, backup/restore, key rotation, media diagnosis, pre-release gates |

## Verified commands (Windows dev machine, Git Bash or PowerShell)

```sh
docker compose -f infra/compose.dev.yml up -d          # postgres (127.0.0.1:55432), livekit, sound-publisher, asset-validator
cd apps/api && dotnet run --project src/Hangar.Api      # http://localhost:5080; migrates + seeds; logs a one-time owner invite
cd apps/api && dotnet test                              # stop the running API first (it locks bin/); Testcontainers needs Docker
cd apps/web && npx ng serve --port 4200                 # proxy /api and /hubs → :5080
cd apps/web && npx ng build                             # production build (dist/web/browser)
cd tests/e2e && node scripts/smoke-chat.mjs ../../.tmp/shots          # also: smoke-voice, smoke-stream, smoke-soundboard,
                                                                       # smoke-settings, smoke-attachments, smoke-responsive
cd tests/e2e && node scripts/smoke-notifications.mjs
cd apps/api && dotnet dotnet-ef migrations add <Name> -p src/Hangar.Core -s src/Hangar.Api -o Persistence/Migrations -- --environment Development
```

npm: the lockfile is written by npm 11.6.2 — use `npx -y npm@11.6.2 install …` when the system npm is older.
Dev logins (local database only): `tomer` / `friend`, password in `.claude/memory/HEARTBEAT.md`.

Production images and checks (no deployment from here):

```sh
docker build -t hangar-api:<v> apps/api
docker build -t hangar-edge:<v> -f infra/caddy/Dockerfile .           # Caddy 2.11.4 + caddy-l4 v0.1.2 + SPA
docker run --rm -e APP_HOST=a.example -e RTC_HOST=r.example -e TURN_HOST=t.example -e ACME_EMAIL=x@example \
  hangar-edge:<v> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
HANGAR_ROOT=<dir with filled config/> docker compose -f infra/compose.prod.yml --env-file infra/config.example/hangar.env \
  --profile release --profile ops config --quiet
```

The signaling gate can be exercised locally with `infra/caddy/Caddyfile.gate-dev` and `tests/e2e/scripts/gate-check.mjs`
(steps in the Caddyfile header).

## Conventions

- Angular: feature folders under `src/app/features`, root stores/services under `src/app/core`, prototype class names
  from `src/styles/design.css`. Components use signals and `ChangeDetectionStrategy.OnPush`.
- .NET: thin endpoints; application services own permission checks and transactions. State transitions that race
  (voice leases, sound plays) are compare-and-set `ExecuteUpdate`s. DTOs stay separate from EF entities.
- Workers: no shell commands built from user input, bounded timeouts, immutable asset names.
- Keep text files LF (`.gitattributes`). Shell scripts that go into images must be LF in the working tree.
