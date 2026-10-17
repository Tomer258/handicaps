# HEARTBEAT — update after every slice

**Last update:** 2026-10-17 — session 1

## Slice plan (status)
- [x] S0 Repo setup: CLAUDE.md, hooks (path guard + session context), memory, docs/ copied from _inputs, git init
- [ ] S1 Backend foundation: solution, EF model (identity/membership/channels/messages), migrations, compose (postgres), auth (csrf/register-by-invite/login/logout/me/sessions), owner bootstrap, permission evaluator + tests
- [ ] S2 Frontend foundation: Angular 21 app, design tokens, AppShell grid, login/register, core/api + core/auth, dev proxy
- [ ] S3 Text: channels, messages (send/edit/delete/reply/react), ChannelEvent outbox + dispatcher, SignalR hub, presence/typing, read positions/unreads, mentions/notifications; UI: sidebars, message list, composer, members
- [ ] S4 Voice: LiveKit compose, voice leases, JWT, admission endpoint, webhooks, reconciler; UI: MediaSessionService, voice control bar, participant grid, mute/deafen, per-user volume, audio buses, speaking
- [ ] S5 Screen share: publication reservations, share dialog, stream viewer, multi-stream grid
- [ ] S6 Soundboard: file storage, upload + asset-validator worker, catalog/favorites/preview, sound-plays (reservations/rate limits), sound-publisher worker, track registry; UI popover
- [ ] S7 Settings, admin (invites/roles), attachments/avatars, notifications, responsive
- [ ] S8 Prod infra: Caddy (+forward_auth gate), prod compose, livekit.yaml, backups, runbooks, CI, AGENTS.md

## In progress
- S1 not started.

## Next exact step
- Create apps/api solution with dotnet new.

## Verified commands
- (none yet)

## Known issues / notes
- (none)
