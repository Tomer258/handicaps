# HEARTBEAT — update after every slice

**Last update:** 2026-10-18 — session 2 (S0–S8, search, watchdog, POC bootstrap + local POC committed and pushed; plan reordered POC-first)

## Slice plan (status)
- [x] S0 Repo setup: CLAUDE.md, hooks (path guard + session context), memory, docs/ copied from _inputs, git init
- [x] S1 Backend foundation: solution, EF model (identity/membership/channels/messages), migrations, compose (postgres), auth (csrf/register-by-invite/login/logout/me/sessions), owner bootstrap, permission evaluator + tests
- [x] S2 Frontend foundation: Angular 21 app, design tokens, AppShell grid, login/register, core/api + core/auth, dev proxy
- [x] S3 Text: channels, messages (send/edit/delete/reply/react), ChannelEvent outbox + dispatcher, SignalR hub, presence/typing, read positions/unreads, mentions/notifications; UI: sidebars, message list, composer, members
- [x] S4 Voice: LiveKit compose, voice leases, JWT, admission endpoint, webhooks, reconciler; UI: MediaSessionService, voice control bar, participant grid, mute/deafen, per-user volume, audio buses, speaking
- [x] S5 Screen share + camera: publication reservations (caps 4 screens/6 cameras), source grants via UpdateParticipant, track webhooks → roster flags; UI share dialog, stream view (focus/grid, per-stream audio), camera in pcards, live banner
- [x] S6 Soundboard: file storage, upload + asset-validator worker, catalog/favorites/preview, sound-plays (reservations/rate limits), sound-publisher worker, track registry; UI popover
- [x] S7 Settings, admin (invites/roles), attachments/avatars, notifications, responsive
- [x] S8 Prod infra: Caddy (+forward_auth gate), prod compose, livekit.yaml, backups, runbooks, CI, AGENTS.md

## In progress
- S7 split into sub-slices: [x] S7a settings dialog + invites/roles (46a2d9f) · [x] S7b attachments + avatars · [x] S7c notifications · [x] S7d responsive + keyboard shortcuts/a11y.

## S9 admin & permissions (user request 2026-10-18: "add the admin panel and permissions and such, then continue normally")
- [x] S9a role hierarchy + role CRUD (21fcf28): Core/Permissions/RoleAuthority.cs, PermissionService.RequireAuthorityAsync/TopPositionAsync; WorkspaceService Create/Update/Delete/ReorderRoles, SetMemberRoles + RemoveMember hierarchy; ChannelService.SetOverrideAsync same rules. Routes POST/DELETE /servers/{id}/roles[/{roleId}], PUT /servers/{id}/roles/order. Tests RoleTests (2).
- [x] S9b voice moderation: ServerMember.VoiceMuted (migration MemberVoiceMute) → lease.ServerMuted on join; VoiceService.SetServerMuteAsync (MuteMembers in the lease channel, else server-level; withdraws mic source + MutePublishedTrack) / DisconnectAsync (RemoveFromVoice; lease Revoked 'removed'). PUT /servers/{id}/members/{uid}/voice/mute {muted}, DELETE /servers/{id}/members/{uid}/voice. Web: media.serverMuted from local ParticipantPermissions (mic source 2 missing), card menu "Server mute"/"Disconnect from voice". Test VoiceTests.Server_mute… (63 pass); smoke-moderation.mjs passes.
- [ ] S9c channel settings UI (rename/topic/delete) + overrides editor (tri-state per role/member) on GET/PUT /channels/{id}/overrides
- [ ] S9d audit log: GET /servers/{id}/audit (ViewAudit) + UI
- [ ] S9e admin UI: roles create/rename/color/hoist/delete/reorder, members view, hierarchy explained

## S7a/S7b notes (done)
- S7a: core/settings/user-settings.service.ts (PATCH /users/me/settings debounced w/ expectedVersion, 412 → reload+retry; preferredStatus normalized; notification prefs {messages all|mentions|none, mentionsInVoice, chimes}); core/media/media-prefs.service.ts (localStorage 'hangar.mediaPrefs'); features/settings/* sections.
- S7b backend: Core/Files/FileService.cs (attachments: images → validator 'image.normalize' → WebP; text .txt/.log/.md/.csv/.json UTF-8 checked, always download; avatars 256×256 crop; reads authorized via parent message channel ViewChannel / avatars via shared server; GC orphans 24h + deleted-message attachments), Core/Files/ValidationCollector.cs (single spool reader, dispatch by JobType), Api/Endpoints/FileEndpoints.cs (nosniff + sandbox CSP + CORP). Validator mounts ../.data/files/images. Tests: FileTests (4) + FakeValidator → 55 pass.
- S7d: LayoutService.breakpoint (matchMedia: xl≥1600, lg≥1280, md≥1080, sm≥820, xs) — members aside docked ≥1280, overlay toggle below (Esc/click-out closes); <820 drawer shows rail + sidebar (.app.nav-open); AppShell (document:keydown) Ctrl+Shift+M/D (works while typing; toast feedback); features/shell/voice-pill.ts above composer on xs; soundboard popover = bottom sheet on xs (.sb-pop) and takes/returns focus; (pointer:coarse) 44px targets. Fixed: unmute outside voice was blocked by canSpeak check.
- S7c: features/notifications/notifier.service.ts (root, injected by AppShell): mentions (server 'notificationCreated', deduped per message) → toast if focused & other channel, browser Notification if background; 'all' mode from message.created events; DND silences all; mentionsInVoice; chimes via MediaSessionService.onPeersChanged (sync callback — effects are deferred in background tabs) keyed by room generation; dispatches 'hangar:chime' DOM event (smoke hook). UserSettingsService flushes pending PATCH with fetch keepalive on pagehide.
- S7b frontend: features/messages/attachment-uploads.ts (per-channel tray provided by TextChannelPage; upload → poll /files/{id}/status), composer paperclip/paste chips, page drag&drop zone + image viewer (ChannelUi.viewer), message-item .att-img / .att-file; hx-avatar [assetId] + avatarUrl(); account section avatar upload/remove (memberUpdated pushes to others).

## S6 notes (done)
- Backend: Core/Files/FileStore.cs, Core/Soundboard/{SoundboardService,SoundPlaybackService}.cs, Api/Endpoints/SoundboardEndpoints.cs, Api/Realtime/SoundboardRealtime.cs (SignalR soundCatalogChanged / soundPlaybackChanged, SoundboardLoop 1s). Workers: workers/asset-validator (ffmpeg), workers/sound-publisher (livekit rtc 1.1.20; shares livekit netns; 127.0.0.1:8090).
- PublisherUrl must be 127.0.0.1 (not localhost: Windows tries ::1 first → 2 s connect delay).
- Tests: SoundboardTests (6) with FakeSoundPublisher; ApiFactory sets Storage:Root to temp dir, WorkerKey, removes SoundboardLoop (tests call CollectAsync/ReconcileAsync). Validator simulated by copying input→output + writing spool/results json.
- Frontend: features/soundboard/{soundboard.store,soundboard-popover,sound-upload.dialog}.ts; media-session subscribes sb_* participants' sfx_<userId> tracks (soundVolume/soundMuted/mutedActors in localStorage 'hangar.soundboard'); detach on TrackSubscriptionStatusChanged(Unsubscribed) because tracks only end after SFU renegotiation; re-attach on Subscribed. Dock z-index 26 above popover backdrop. Card menu: "Mute their soundboard".

## Remaining plan — reordered POC-first (2026-10-18, user request: working template ASAP; nothing removed)
Items are the existing remaining work (pre-release-gates.md manual list + roadmap Phase 7), only re-sequenced.
- [x] P1a Local POC (no VPS): `bash infra/scripts/poc-local.sh up` → unmodified prod stack in DinD (docker:28.5.1-dind, privileged; host ports 80/443/7881/7882udp; stops dev livekit+publisher) at https://app.hangar.localhost via `poc-bootstrap.sh --local` (LiveKit node_ip 127.0.0.1). Verified 2026-10-18: poc-verify.sh --insecure 10/10; poc-smoke.mjs (owner invite → register, invite friend, realtime chat, voice with real audio through gate). `poc-local.sh invite|fresh|down|reset|dc …|ca`. Pushed to origin https://github.com/Tomer258/handicaps_discord.git.
- [ ] P1 POC deploy (needs user: VPS + domain + DNS): deploy.md §1 steps 1–3 by hand, then
      `sudo ./infra/scripts/poc-bootstrap.sh --domain <d> --email <e> --ufw` (steps 4–6 + §2), then deploy.md §3 verify.
      Bootstrap script verified locally: config-only run in Linux, secrets consistent, LiveKit starts with generated keys, compose resolves.
- [ ] P2 Gates that prove the POC is safe to share (pre-release-gates.md manual): bypass attempts (:7880, IPv6, turn. HTTP, :5349),
      session revocation token replay, TURN/TLS via 443 with UDP+7881 blocked, authorization watchdog drill.
- [ ] P3 Real-use gates: two real Windows clients 30 min (mic, deafen, screen share with audio, soundboard); backups configured + restore drill on a fresh VM.
- [ ] P4 Phase 7 hardening: A/B/C load results, four-hour soak, security review, dashboards/alerts, pinned images/source versions,
      dependency/license review, host quote; tests: external port scan, forced TURN, abuse/rate, DB outage, API/worker/SFU restarts,
      interrupted upload, disk-full, expired-cert alert, rollback with compatible schema.

## Next exact step
Local POC runs (P1a). User will get a VPS once happy with the local POC → then P1 with poc-bootstrap.sh. POC smoke now covers attachments, soundboard and screen share on the prod stack, plus a watchdog drill on prod compose (64 s trip, 34 s reopen); all passed. Test runs use `POC_DATA=hangar-poc-test` so the user's POC accounts (default volume hangar-poc-srv) are untouched. The user's own POC data is kept: `bash infra/scripts/poc-local.sh up` restarts it. Bootstrap now stages config atomically and refuses partial configs. In Git Bash, export MSYS_NO_PATHCONV=1 before `docker exec ... /srv/...` checks.
P2 session-revocation replay now automated in gate-check.mjs (initial + refreshed token, fresh + resume, 4 routes) and passing locally through the dev gate; still to repeat on the host. TURN/TLS gate rehearsed locally: POC_NODE_IP=container + POC_FORCE_RELAY=1 poc-smoke → all paths relay/tls via Caddy layer4 (3/3). Found + fixed prod-only bug: validator ffmpeg threads vs pids_limit 64 (intermittent image decode_failed). Remaining P2 items needing a public host: bypass ports/IPv6, real-network TURN. Screen share already exists (S5) and is in poc-smoke; user asked to prioritize it — it is done.
Voice panel (sidebar, above the user row) now has the prototype's 4-button row: camera, share screen, soundboard, voice settings. LayoutService.soundboardOpen/shareOpen are shared with the dock; ServerView renders the soundboard popover + Go-live dialog so they work on any page (closed on disconnect).

## Watchdog notes (done)
- API: Core/Media/ReconcileHealth.cs (singleton; VoiceService.ReconcileAsync now returns bool complete and records it); GET /internal/watchdog/reconcile (200/503); AdmitAsync refuses when not Fresh (no complete pass for 3×ReconcileInterval). Tests: ReconcileHealthTests (2) + VoiceTests watchdog endpoint → 60 pass.
- workers/auth-watchdog/watchdog.py (stdlib, uid 10003, dedicated LiveKit key 'watchdog'): unhealthy/unreachable 60 s → flag file + DeleteRoom all rooms every check; healthy 30 s → remove flag. Caddy rtc host: `@watchdog_closed file` → respond 503 inside a `route` before forward_auth. compose.prod auth-watchdog service; /srv/hangar/watchdog (10003, 755) mounted ro into edge.

## Search notes (done)
- GET /servers/{id}/messages/search?q&from&channel&before&limit (MessageService.SearchAsync): ILIKE with escaped wildcards over pg_trgm GIN (migration MessageSearchIndex, partial WHERE deleted_at IS NULL), scoped to ViewChannel channels, newest first, cursor = CreatedAt.UtcTicks. Tests: SearchTests (2) → 57 pass.
- Web: features/messages/search-panel.ts (Ctrl/Cmd K via AppShell, header button; from:/in: syntax + hint chips; 250 ms debounce + generation guard); LayoutService.searchOpen/jumpTarget; TextChannelPage effect jumps once the channel is loaded; ChannelUi.jumpTo waits frames and pages older history in.

## S8 notes (done)
- apps/api/Dockerfile (uid 10001, 127.0.0.1:8080, `--migrate` one-off); infra/caddy/{Dockerfile,Caddyfile,Caddyfile.gate-dev}; infra/compose.prod.yml (profiles release/ops); infra/livekit.prod.yaml (key_file 0600); infra/config.example/*; infra/backup/{Dockerfile,backup.sh,restore.sh}; docs/runbooks/*; .github/workflows/ci.yml; AGENTS.md.
- Verified locally: caddy validate (layer4 + forward_auth), compose config, LiveKit starts with prod config, gate-check.mjs + voice smoke through real Caddy forward_auth, API image --migrate on an empty DB, prod cookies `__Host-` behind trusted proxy, backup→restore round trip (identical counts).

## Verified commands
- `docker compose -f infra/compose.dev.yml up -d`  (Postgres on 127.0.0.1:**55432** — 5432 is blocked on this PC)
- `cd apps/api && dotnet build` ; `dotnet test` (60 pass; stop the running API first — it locks bin/; integration uses Testcontainers postgres:18-alpine)
- `cd apps/api && dotnet run --project src/Hangar.Api` → http://localhost:5080, migrates + seeds, logs one-time owner invite link
- `cd apps/web && npx ng build --configuration development` ; `npx ng serve` (proxy → :5080). npm installs: `npx -y npm@11.6.2 install ...` (system npm 11.0.0 has arborist bug)
- Voice smoke (real LiveKit, fake mic, 2 browsers): `cd tests/e2e && node scripts/smoke-voice.mjs ../../.tmp/shots` (needs compose livekit up)
- Stream smoke (camera + screen share, live banner, stream view, flags): `cd tests/e2e && node scripts/smoke-stream.mjs ../../.tmp/shots`
- Soundboard smoke (upload+trim via validator, play via publisher, receive sfx track, cooldown, favorites, per-actor mute): `cd tests/e2e && node scripts/smoke-soundboard.mjs ../../.tmp/shots` (needs full compose + API + ng serve)
- Settings smoke: `cd tests/e2e && node scripts/smoke-settings.mjs ../../.tmp/shots`
- Attachments smoke (real validator: image→webp, text card, drop, viewer, avatar 256² to friend, removal): `node scripts/smoke-attachments.mjs ../../.tmp/shots`
- Notifications smoke (stubbed Notification + simulated background; chimes in Lounge): `node scripts/smoke-notifications.mjs`
- Responsive smoke (1440/1200/390, shortcuts, drawer, pill, bottom sheet): `node scripts/smoke-responsive.mjs ../../.tmp/shots`
- Gate check (Caddy forward_auth in front of dev LiveKit): see infra/caddy/Caddyfile.gate-dev header, then `node scripts/gate-check.mjs`
- Edge image: `docker build -f infra/caddy/Dockerfile -t hangar-edge:dev .` ; API image: `docker build -t hangar-api:dev apps/api`
- Search smoke (Ctrl K, filters, Hebrew, cross-channel jump, deep jump through 120 newer messages): `node scripts/smoke-search.mjs ../../.tmp/shots`
- Watchdog drill (gate container with .tmp/watchdog mounted + watchdog on host with TRIP_AFTER=15 RECOVER_AFTER=8 INTERVAL=2; script kills/restarts the API): see header of `node scripts/watchdog-drill.mjs`. Afterwards restart the API normally (the drill leaves it on PublicUrl ws://localhost:7890).
- Voice panel smoke (sidebar call actions from a text page: soundboard, share, camera, voice settings): `node scripts/smoke-voice-panel.mjs ../../.tmp/shots`
- Chat smoke (2 browsers, realtime/mentions/typing/reply/react/edit/badge/delete): `cd tests/e2e && node scripts/smoke-chat.mjs ../../.tmp/shots` (needs API + ng serve running)
- E2E/smoke: `cd tests/e2e && node scripts/smoke-owner.mjs ../../.tmp/api.log ../../.tmp/shots` (Playwright chromium in .cache/ms-playwright). Dev login: tomer / "correct horse battery" (local dev DB only)
- `cd apps/api && dotnet dotnet-ef migrations add <Name> -p src/Hangar.Core -s src/Hangar.Api -o Persistence/Migrations -- --environment Development`

## Known issues / notes
- ng serve logs to .tmp/ng.log; API to .tmp/api.log.
- Editing files with Python on Windows: open(..., newline='') / write with newline='
' — text mode writes CRLF (breaks shell scripts copied into images).
- Docker Desktop may need launching: user allowed `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`.
- Backend layout: Hangar.Api (host, Endpoints/, Infrastructure/, Realtime/) + Hangar.Core (modules by folder; DbContext in Persistence/). Realtime: core/realtime/realtime.service.ts (single hub conn, presence heartbeat, policy reload); features/messages/chat.store.ts (per-channel cursor, gap resync, optimistic sends, unread badges, typing). Dev user 'friend' exists (same password). Voice: core/media/media-session.service.ts (one Room, explicit audio subs, webAudioMix per-user volume 0-200%), Core/Media/VoiceService.cs (leases, JWT, admission, webhook, reconcile).
- Full DB schema (incl. media/soundboard tables) is in migration Initial.
- Frontend: global design CSS ported from prototype in apps/web/src/styles/design.css (class names = prototype); tokens.css; components use those classes. Icons: shared/ui/icons.ts (+ hx-icon).
- Frontend stores (root): SessionService, WorkspaceStore, PresenceStore, VoicePresenceStore, ChannelBadges, MediaSessionService (skeleton), LayoutService, ToastService, PreferencesService.
- Routes: /login, /invite/:secret, /offline, '' (AppShell) → '' Home, s/:serverId (ServerView) → c/:channelId, v/:channelId.
- EF Core pinned to 10.0.13 via explicit Relational reference (Npgsql 10.0.3 pulls 10.0.4).

- Voice lease transitions decided from snapshots (webhook participant_left, reconciler grace/timeout, MarkActive) are compare-and-set ExecuteUpdates — plain tracked updates resurrected ended leases (zombie Joining rows → ux_voice_leases_one_active 500 on switch).
- Vite error overlay can linger after transient build errors and block Playwright clicks: just rerun once ng serve log shows a clean build.
