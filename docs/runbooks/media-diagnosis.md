# Media diagnosis

## Someone cannot join voice

1. Check the browser console. A `403` on `wss://rtc…/rtc` means the admission gate refused the connection. Look at
   `dc logs api` around that time for the reason: lease ended or revoked, session revoked, missing Connect
   permission, or a foreign Origin. A `404` on `/rtc/v1` followed by a request to `/rtc` is normal (livekit-client
   falls back).
   A `503` with "Voice is temporarily unavailable" means the authorization watchdog has closed voice; see below.
2. `dc logs livekit | grep -i participant` shows whether the participant reached the SFU.
3. Connected but no audio usually means ICE. Test from the affected network: if UDP 7882 and 3478 are blocked, the
   client should use TCP 7881, and then TURN/TLS on 443. `dc logs edge` shows the layer4 TLS handshake for `turn.`
   when TURN/TLS is in use.

## Audio or video quality

- On the host, check `top` (CPU steal), `free -m` and `ss -uam` (UDP drops). LiveKit metrics are on
  `127.0.0.1:6789`; reach them through an SSH tunnel.
- The API caps screen shares at 4 publications and cameras at 6. "Server full" messages come from those
  reservations.

## Soundboard is silent

- `dc logs sound-publisher`: a change of epoch means the publisher restarted. Sounds in flight at that moment are
  failed and never replayed.
- `dc logs api | grep -i sound`: `busy`, `cooldown` and `rate` rejections are policy, not faults.
- Listeners can mute the soundboard globally or per member (Settings › Soundboard, or the member card menu).

## Uploads stuck on "processing"

- Check `dc logs asset-validator`. The API fails jobs in `/srv/hangar/data/files/spool/jobs` that are older than
  3 minutes.
- Every directory under `data/files` must be owned by uid 10001.

## Voice closed by the authorization watchdog

The watchdog (`auth-watchdog`) closes voice when the API's voice reconciliation has been unhealthy, or the API has
been unreachable, for 60 s. That reconciliation is what enforces revocations on people who are already connected. The
watchdog then creates `/srv/hangar/watchdog/closed`, which makes the edge answer `503` on `/rtc`, and it deletes every
LiveKit room on each check. Even before that, the API refuses new admissions once reconciliation is 45 s stale.

1. `curl -s 127.0.0.1:8080/internal/watchdog/reconcile` on the host shows `healthy`, `lastSuccessAt` and
   `lastAttemptAt`.
2. `dc logs api | grep -i reconcil` gives the cause: database errors, or "LiveKit RoomService unavailable" (check
   `dc ps livekit` and `dc logs livekit`).
3. Fix the cause. Voice reopens by itself after 30 s of healthy status, and clients rejoin normally. Do not delete
   the flag by hand while the status is unhealthy: the watchdog recreates it.
