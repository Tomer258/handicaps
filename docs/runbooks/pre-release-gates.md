# Pre-release gates

Run these before inviting people, and again after any LiveKit, Caddy, auth or media change. Record each result with
the date and version.

## Automated (development stack)

- `cd apps/api && dotnet test`: includes the admission/revocation, permission, soundboard and file-access tests.
- Playwright smokes in `tests/e2e/scripts/`: chat, voice, stream, soundboard, settings, attachments, notifications,
  responsive, search, admin, moderation, voice panel and two-step login (`smoke-2fa.mjs`: QR enrolment, code and
  recovery-code sign-in, turning it off). UX states: `smoke-states.mjs` (loading skeleton, no camera, soundboard
  without permission) and `smoke-reconnect.mjs`. In the reconnect smoke, a crashed friend's card stays marked
  "Reconnecting…" until the server's grace ends, and a deliberate leave never shows that state.
- Gate check through a real Caddy forward_auth (`infra/caddy/Caddyfile.gate-dev` plus `node scripts/gate-check.mjs`;
  steps are in the Caddyfile header). Expected: a live token is admitted. Refused on `/rtc`, `/rtc/validate`, `/rtc/v1`
  and `/rtc/v1/validate`: a foreign Origin, a garbage or missing token, Twirp paths, and a token replayed after
  leaving. The voice smoke also passes through the gate.
  **Passed 2026-10-18** (Caddy 2.11.4 + caddy-l4 v0.1.2, LiveKit v1.9.1, livekit-client 2.23).
  The same script also covers session revocation. An initial and a server-refreshed token, both admitted before,
  are refused after another device revokes the session. This holds for fresh and resume (`reconnect=1&sid=`)
  attempts on all four routes. **Passed 2026-10-18.** Repeat it on the host (below).

## Local rehearsal of the production stack (`infra/scripts/poc-local.sh`)

The unmodified `compose.prod.yml` runs inside a Docker-in-Docker "VPS" at `*.hangar.localhost`.
**Passed 2026-10-18:**
- `poc-verify.sh --insecure`: 10/10 checks.
- `poc-smoke.mjs`: invite registration, realtime chat, an image through the validator, voice with real audio
  through the gate, soundboard upload and play through the publisher, and a screen share.
- Watchdog drill: closed 64 s after `dc stop api` (flag owned by uid 10003, `/rtc` returned 503), and reopened 34 s
  after `dc start api`.

- Forced TURN/TLS (`POC_NODE_IP=container`, `POC_FORCE_RELAY=1 node scripts/poc-smoke.mjs`): browsers may only use
  relays, and LiveKit advertises an address they cannot reach. Every selected path was `relay/tls`, through Caddy's
  layer4 `turn.` route to LiveKit TURN. Voice, soundboard and screen share all worked. 3/3 runs passed.

## Restart, outage and abuse drills (dev stack, `tests/e2e/scripts/resilience-drill.mjs`)

**Passed 2026-10-18 (3/3 runs, plus once more with automatic voice rejoin):**
- API killed and restarted (~8 s down): voice kept flowing, session cookies stayed valid, realtime chat resumed
  without a reload, and nobody dropped from voice.
- PostgreSQL stopped for 20 s: `/healthz` returned 503 and writes returned 503 `service.unavailable` with `Retry-After`.
  Voice kept flowing. The API recovered on its own about 2 s after PostgreSQL returned. A message typed during the
  outage was delivered automatically afterwards.
- LiveKit restarted: both clients rejoined on their own within about 7 s (fresh lease each time), the voice roster
  matched after a reconcile pass, and a moderator's "Disconnect" is still not undone by the automatic rejoin.
- Sound publisher restarted: the soundboard played again straight away.
- Abuse limits: per-user 429 `rate_limited` with `Retry-After` on message/upload/voice/write floods and a
  per-connection hub budget (integration tests `RateLimitTests`). All 12 dev smokes pass with limits on.

- Ops monitor (local POC, 2026-10-18): alerts reached a webhook for the missing backup and for Caddy's short-lived
  local certificates; stopping the API raised `api` after 3 min and `reconcile` after 5 min, and both RESOLVED within
  a minute of `dc start api`.

- Rollback compatibility (2026-10-18): the previous release's API (`21fcf28`) ran against the latest schema. Four
  smokes passed and the server logged no errors. The migration lint runs in CI (rollback.md).

- Session revocation drill rehearsal (2026-10-18, local POC test data set, through Caddy forward_auth → admission →
  LiveKit): `gate-revocation.sh --domain hangar.localhost --insecure` passed 18/18. Before revocation both tokens
  validate (200) and the initial one upgrades to a WebSocket (101); afterwards /rtc/validate, /rtc/v1/validate, fresh
  /rtc and /rtc/v1 upgrades and a reconnect=1 resume all answer 403 for both tokens, and the cookie gets 401.

- Authorization watchdog drill rehearsal (2026-10-18, local POC, two real browser clients held in voice by
  `tests/e2e/scripts/poc-hold-voice.mjs`): `gate-watchdog.sh` passed 10/10. Voice closed 62 s after `dc stop api`
  (flag, every room deleted, `voice signaling CLOSED` logged), both clients dropped at the same moment, the edge
  answered 503 to a token valid seconds earlier; access reopened 36 s after `dc start api` and a new join was admitted.

This does not replace the host checks below, which need public networking.

## Manual, on the production host (not done yet, required)

- [ ] Session revocation: obtain an initial and a server-refreshed LiveKit token, revoke the session, then replay
      both tokens on fresh connections and on resume attempts. Every attempt must be denied. Automated from outside
      the host: `HANGAR_LOGIN=<test member> HANGAR_PASSWORD=… ./infra/scripts/gate-revocation.sh --domain <d>`
      (an account without two-step login; it signs in a throwaway session and revokes only that one).
- [ ] Bypass attempts: direct `:7880`, the IPv6 address, an HTTP request to the `turn.` hostname, and `:5349` from
      outside. None may give access.
- [ ] TURN/TLS: a client with UDP and TCP 7881 blocked joins and hears audio via 443.
- [ ] Two real Windows clients test microphone, deafen, screen share with audio and the soundboard for 30 minutes.
- [ ] Restore drill on a fresh VM (backup-restore.md), with the duration recorded.
- [ ] Authorization watchdog drill: with two clients in voice, `dc stop api`. Within about 65 s both clients drop,
      `dc logs auth-watchdog` shows `voice signaling CLOSED`, and `/srv/hangar/watchdog/closed` exists. Rejoins get
      `503`. `dc start api`. About 30 s after the API is healthy the flag is gone and clients can rejoin. Alert on
      `auth-watchdog` ERROR lines, on its container health, and on `Voice reconciliation` warnings in the API log.
      Automated on the host (keep the two clients in voice; the drill account must be a third one, since its own
      join would replace a client's lease): `HANGAR_LOGIN=<third member> HANGAR_PASSWORD=… ./infra/scripts/gate-watchdog.sh --domain <d>`.
