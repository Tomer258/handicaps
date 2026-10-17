# HEARTBEAT — update after every slice

**Last update:** 2026-10-17 — session 1

## Slice plan (status)
- [x] S0 Repo setup: CLAUDE.md, hooks (path guard + session context), memory, docs/ copied from _inputs, git init
- [x] S1 Backend foundation: solution, EF model (identity/membership/channels/messages), migrations, compose (postgres), auth (csrf/register-by-invite/login/logout/me/sessions), owner bootstrap, permission evaluator + tests
- [x] S2 Frontend foundation: Angular 21 app, design tokens, AppShell grid, login/register, core/api + core/auth, dev proxy
- [x] S3 Text: channels, messages (send/edit/delete/reply/react), ChannelEvent outbox + dispatcher, SignalR hub, presence/typing, read positions/unreads, mentions/notifications; UI: sidebars, message list, composer, members
- [x] S4 Voice: LiveKit compose, voice leases, JWT, admission endpoint, webhooks, reconciler; UI: MediaSessionService, voice control bar, participant grid, mute/deafen, per-user volume, audio buses, speaking
- [ ] S5 Screen share: publication reservations, share dialog, stream viewer, multi-stream grid
- [ ] S6 Soundboard: file storage, upload + asset-validator worker, catalog/favorites/preview, sound-plays (reservations/rate limits), sound-publisher worker, track registry; UI popover
- [ ] S7 Settings, admin (invites/roles), attachments/avatars, notifications, responsive
- [ ] S8 Prod infra: Caddy (+forward_auth gate), prod compose, livekit.yaml, backups, runbooks, CI, AGENTS.md

## In progress
- S5 Screen share (not started).

## Next exact step
- S5: POST/DELETE /voice/{leaseId}/publications/{kind} (MediaPublicationReservation, installation limits, UpdatePublishSources via RoomService adds camera/screen_share(+audio) sources), webhooks track_published/unpublished → VoiceMemberDto camera/screen flags; UI share dialog (capture inside click, publish after reservation), stream viewer (explicit video subscription), grid up to 4, theater. Prototype: SHARE SCREEN FLOW (~962) + STREAM VIEW (~679).

## Verified commands
- `docker compose -f infra/compose.dev.yml up -d`  (Postgres on 127.0.0.1:**55432** — 5432 is blocked on this PC)
- `cd apps/api && dotnet build` ; `dotnet test` (41 pass; integration uses Testcontainers postgres:18-alpine)
- `cd apps/api && dotnet run --project src/Hangar.Api` → http://localhost:5080, migrates + seeds, logs one-time owner invite link
- `cd apps/web && npx ng build --configuration development` ; `npx ng serve` (proxy → :5080). npm installs: `npx -y npm@11.6.2 install ...` (system npm 11.0.0 has arborist bug)
- Voice smoke (real LiveKit, fake mic, 2 browsers): `cd tests/e2e && node scripts/smoke-voice.mjs ../../.tmp/shots` (needs compose livekit up)
- Chat smoke (2 browsers, realtime/mentions/typing/reply/react/edit/badge/delete): `cd tests/e2e && node scripts/smoke-chat.mjs ../../.tmp/shots` (needs API + ng serve running)
- E2E/smoke: `cd tests/e2e && node scripts/smoke-owner.mjs ../../.tmp/api.log ../../.tmp/shots` (Playwright chromium in .cache/ms-playwright). Dev login: tomer / "correct horse battery" (local dev DB only)
- `cd apps/api && dotnet dotnet-ef migrations add <Name> -p src/Hangar.Core -s src/Hangar.Api -o Persistence/Migrations`

## Known issues / notes
- Docker Desktop may need launching: user allowed `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`.
- Backend layout: Hangar.Api (host, Endpoints/, Infrastructure/, Realtime/) + Hangar.Core (modules by folder; DbContext in Persistence/). Realtime: core/realtime/realtime.service.ts (single hub conn, presence heartbeat, policy reload); features/messages/chat.store.ts (per-channel cursor, gap resync, optimistic sends, unread badges, typing). Dev user 'friend' exists (same password). Voice: core/media/media-session.service.ts (one Room, explicit audio subs, webAudioMix per-user volume 0-200%), Core/Media/VoiceService.cs (leases, JWT, admission, webhook, reconcile).
- Full DB schema (incl. media/soundboard tables) is in migration Initial.
- Frontend: global design CSS ported from prototype in apps/web/src/styles/design.css (class names = prototype); tokens.css; components use those classes. Icons: shared/ui/icons.ts (+ hx-icon).
- Frontend stores (root): SessionService, WorkspaceStore, PresenceStore, VoicePresenceStore, ChannelBadges, MediaSessionService (skeleton), LayoutService, ToastService, PreferencesService.
- Routes: /login, /invite/:secret, /offline, '' (AppShell) → '' Home, s/:serverId (ServerView) → c/:channelId, v/:channelId.
- EF Core pinned to 10.0.13 via explicit Relational reference (Npgsql 10.0.3 pulls 10.0.4).
