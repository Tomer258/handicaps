# Decisions (user-confirmed or derived) — keep short, append only

## User decisions (2026-10-17)
- Workspace boundary: ONLY this folder. Nothing on C:/D:/elsewhere. Temp → ./.tmp. Memory → ./.claude/memory.
- Angular **21** (not 22): system Node is 22.13; Angular 22 needs ≥22.22.3. Do not install Node globally.
- Scope: full app in vertical slices, runnable locally via docker compose. Prod infra templates written, not deployed.
- Git: init + commit after each verified slice. **Never push.**
- Package caches inside folder (.cache/*) — configured via .claude/settings.json env, .npmrc, nuget.config.

## Derived technical decisions
- Product name: **Hangar** (from design). Dark theme default, light mirror via [data-theme="light"].
- Monorepo per docs/architecture/development-workflow.md: apps/web, apps/api, workers/sound-publisher, workers/asset-validator, contracts, infra, tests, docs.
- Backend: .NET 10 SDK present (10.0.102). Projects: Hangar.Api (host/endpoints/hubs), Hangar.Application (domain + modules in feature folders), Hangar.Infrastructure (EF Core/Npgsql, LiveKit Twirp client, file storage), tests/Hangar.Tests (xUnit).
- Auth: cookie auth (`__Host-hangar` in prod; plain name on http dev), opaque session id in ticket, UserSession row validated each request. ASP.NET Identity password hasher.
- Dev topology: API runs on host (`dotnet run`), Angular `ng serve` with proxy (same-origin /api, /hubs). Postgres + LiveKit + workers in Docker compose (infra/compose.dev.yml). Shared files via bind mount ./.data.
- LiveKit in Docker Desktop: `--node-ip 127.0.0.1`; sound-publisher shares livekit's network namespace (network_mode: service:livekit) so 127.0.0.1 works for both. Fallback: native livekit-server.exe in ./.tools.
- Python workers: Python 3.13 in Docker images.
- LiveKit pinned livekit/livekit-server:v1.9.1 (dev compose, config infra/livekit.dev.yaml, auto_create=false; API creates rooms with 16 slots). Dev keys hangar-dev/… are local-only.
- Lease id = LiveKit identity; participant metadata {"userId"}. Join token grants microphone only; camera/screen sources added per publication reservation (S5) via RoomService UpdateParticipant.
- Roster visibility = lease Active, or Joining after having been confirmed (reconnect grace 45s). Confirmation is server-verified (webhook, POST /voice/{id}/confirm → ListParticipants, or reconciler).
- /internal/livekit/{webhook,admission} live outside /api/v1 (no cookie/CSRF). S8 Caddy: block /internal publicly; forward_auth admission on ALL signaling routes: /rtc, /rtc/v1 (livekit-client 2.23 tries it first, falls back on 404), /rtc/validate.

## S8 production infra (2026-10-18)
- Single-host topology: edge (Caddy), livekit, api, sound-publisher use host networking and talk over 127.0.0.1; postgres published on loopback; asset-validator network none. API uid 10001 = validator uid (shared file store).
- Edge = Caddy 2.11.4 + caddy-l4 v0.1.2 (v0.1.2 requires Caddy ≥2.11.4). :443 layer4: SNI turn.* → TLS terminate → LiveKit TURN 127.0.0.1:5349 (external_tls); everything else → PROXY protocol v2 → Caddy HTTPS server 127.0.0.1:8443. ACME via HTTP-01 on :80 (TLS-ALPN impossible behind layer4).
- rtc.* host: forward_auth (API /internal/livekit/admission) on /rtc and /rtc/* then LiveKit; all else 404. Access logs strip access_token. app.* blocks /internal/*.
- LiveKit v1.9.1 with bind_addresses [127.0.0.1] still binds TURN 5349/tcp on all interfaces (verified) → host firewall must drop 5349.
- appsettings.json is production-safe (SecureCookies true, no connection string); dev values live in appsettings.Development.json. EF CLI needs `-- --environment Development`.
- Production migrations: one-off `--migrate` job (API exits after migrate+bootstrap), never on startup.
- Angular prod build: optimization.styles.inlineCritical=false so CSP script-src 'self' works (no inline onload).
- Backups: pg_dump -Fc + file store + DP keys + manifest → age-encrypted single archive, rclone off-host daily/weekly; restore expires all sessions and voice leases.
- Not implemented (documented gap): authorization watchdog closing public signaling after 60 s of unhealthy reconciliation.

