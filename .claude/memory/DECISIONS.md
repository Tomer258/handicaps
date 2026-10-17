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
