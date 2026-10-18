# Pre-release gates

Run these before inviting people, and again after any LiveKit, Caddy, auth or media change. Record each result with
the date and version.

## Automated (development stack)

- `cd apps/api && dotnet test`: includes the admission/revocation, permission, soundboard and file-access tests.
- Playwright smokes in `tests/e2e/scripts/`: chat, voice, stream, soundboard, settings, attachments, notifications
  and responsive.
- Gate check through a real Caddy forward_auth (`infra/caddy/Caddyfile.gate-dev` plus `node scripts/gate-check.mjs`;
  steps are in the Caddyfile header). Expected: a live token is admitted. Refused on `/rtc`, `/rtc/validate`, `/rtc/v1`
  and `/rtc/v1/validate`: a foreign Origin, a garbage or missing token, Twirp paths, and a token replayed after
  leaving. The voice smoke also passes through the gate.
  **Passed 2026-10-18** (Caddy 2.11.4 + caddy-l4 v0.1.2, LiveKit v1.9.1, livekit-client 2.23).

## Manual, on the production host (not done yet, required)

- [ ] Session revocation: obtain an initial and a server-refreshed LiveKit token, revoke the session, then replay
      both tokens on fresh connections and on resume attempts. Every attempt must be denied.
- [ ] Bypass attempts: direct `:7880`, the IPv6 address, an HTTP request to the `turn.` hostname, and `:5349` from
      outside. None may give access.
- [ ] TURN/TLS: a client with UDP and TCP 7881 blocked joins and hears audio via 443.
- [ ] Two real Windows clients test microphone, deafen, screen share with audio and the soundboard for 30 minutes.
- [ ] Restore drill on a fresh VM (backup-restore.md), with the duration recorded.
- [ ] Authorization watchdog drill: with two clients in voice, `dc stop api`. Within about 65 s both clients drop,
      `dc logs auth-watchdog` shows `voice signaling CLOSED`, and `/srv/hangar/watchdog/closed` exists. Rejoins get
      `503`. `dc start api`. About 30 s after the API is healthy the flag is gone and clients can rejoin. Alert on
      `auth-watchdog` ERROR lines, on its container health, and on `Voice reconciliation` warnings in the API log.
