# Build instructions — screen share v2

For the Claude session that builds this. The design and its reasons are in
[docs/architecture/screen-share-v2.md](docs/architecture/screen-share-v2.md); read that first, then this file.
The user approved building it (2026-11-10). Nothing is implemented yet.

## Rules of this repo (from CLAUDE.md)

- Work only inside this folder. Temp files go in `./.tmp/`.
- Read `.claude/memory/HEARTBEAT.md` and `DECISIONS.md` at the start; update `HEARTBEAT.md` after every step below.
- Commit after each verified step. **Never push.**
- Append the decisions you make to `.claude/memory/DECISIONS.md` (short, dated).

## Goal

A screen share that holds 60 fps on a PC with a GPU encoder and stays steady (no layer flapping), and an honest,
steady 30 fps on a PC without one. Today it encodes three VP8 layers in software and wobbles.

## Files you will touch

| File | Role |
|---|---|
| `apps/web/src/app/core/media/media-session.service.ts` | `SCREEN_ENCODING`, `startScreenShare`, `watchVideo`/`unwatchVideo`, Room options |
| `apps/web/src/app/core/media/encode-probe.ts` | new (V2) |
| `apps/web/src/app/core/media/share-governor.ts` | new (V3) |
| `apps/web/src/app/core/media/media-prefs.service.ts` | `streamQuality` pref → mode |
| `apps/web/src/app/features/voice/share-dialog.ts` | Go Live dialog |
| `apps/web/src/app/features/voice/stream-tile.ts` | passes a role to `watchVideo` |
| `apps/web/src/app/features/voice/stream-view.ts`, `voice-room.page.ts` | where tiles are used (stage/grid = full, cards/strip = thumb) |
| `apps/web/src/app/features/voice/stream-stats.ts` | stats rows |
| `apps/api/src/Hangar.Core/Media/VoiceService.cs` (~line 285) | accepted quality values |
| `apps/api/tests/Hangar.Tests/Integration/VoiceTests.cs` | quality tests |
| `tests/e2e/scripts/smoke-stream.mjs`, `stream-stats.mjs`, `smoke-going-live.mjs`, `smoke-share-audio.mjs`, `smoke-responsive.mjs` | must keep passing |

Grep for `ScreenQuality`, `streamQuality`, `1080p60` and `720p30` before changing types; settings and the dialog use them.

## Before writing code: check these in `apps/web/node_modules/livekit-client/dist/livekit-client.esm.mjs` (v2.23.0)

I did not verify these; each one changes how you write the code.

1. **Layer order and rids.** How `screenShareSimulcastLayers` + `screenShareEncoding` become encodings (see
   `computeVideoEncodings`, near line 24020) and which rid (`q`/`h`/`f`) each gets with 2 and with 3 layers.
   `VideoQuality.LOW/MEDIUM/HIGH` map to those rids on the viewer side.
2. **`backupCodec`.** Whether it does anything when `videoCodec` is `h264`. If it would publish a second VP8
   encode, set it to `false`.
3. **`setVideoQuality` with `adaptiveStream` on.** I expect it is ignored with a warning; that is why the design
   turns `adaptiveStream` off. Confirm, and confirm cameras still look right with it off (request `HIGH` for a big
   camera tile, `LOW` for cards).
4. **Dynacast vs. the governor.** `setPublishingLayers` / `setPublishingQuality` also call `sender.setParameters`.
   Make sure the governor only changes `maxFramerate`, `maxBitrate`, `scaleResolutionDownBy` and re-reads
   `getParameters()` each time, so the two do not overwrite each other's `active` flags.
5. **`LocalVideoTrack.sender`** is the `RTCRtpSender` to use for stats and `setParameters`.

## Known trap: the test browser has no H.264

Playwright's bundled Chromium is built without proprietary codecs, so it very likely cannot send or receive H.264
over WebRTC, and it has no hardware encoder. Therefore:

- Pick the codec at runtime: use H.264 only if `RTCRtpSender.getCapabilities('video')` lists it, else VP8. A
  viewer that cannot decode H.264 must still get video — test this with the existing smokes (they are that viewer).
- All existing smokes will run the VP8 software path. Keep them green on that path.
- To exercise H.264 in a script, launch with `channel: 'chrome'` or `channel: 'msedge'` if installed on this PC.
- Add a test hook to force the probe result (for example `localStorage['hangar.forceEncoder'] = 'hardware' | 'software'`,
  dev builds only) so smokes can cover both ceilings.

## Steps

Do them in order. Each ends with: build, run the listed checks, update HEARTBEAT, commit.

### V0 — stats rows (small)

In `stream-stats.ts` add to `NetStats` and the panel:
- **Encoder** (sender): `encoderImplementation` and `powerEfficientEncoder` from the highest `outbound-rtp` →
  "Hardware (name)" / "Software (name)".
- **Transport** (both directions): from the selected `candidate-pair` → its `local-candidate`: `candidateType`
  (`host`/`srflx` = direct, `relay` = relay) and `protocol` / `relayProtocol` → "UDP direct", "TCP", "Relay (TLS)".

Check: `node scripts/smoke-stream.mjs ../../.tmp/shots` (extend it to assert the two rows exist).
Then ask the user to share a real game on this build and report Codec / Encoder / Limited by / Sending. Do not block
on the answer; continue with V1.

### V1 — codec, layers, explicit viewer layers (biggest gain)

In `media-session.service.ts`:
- Publish with `videoCodec` = H.264 when supported (see trap above), else VP8.
- Layers: main = chosen profile; `screenShareSimulcastLayers` = thumb `VideoPreset(640, 360, 250_000, 15)` plus,
  only when main is above 720p30, safe `VideoPreset(1280, 720, 1_500_000, 30)`. Remove the 720p60 middle layer.
- Room option `adaptiveStream: false`. Keep `dynacast: true`.
- `watchVideo(s, role: 'full' | 'thumb')` / `unwatchVideo(s, role)`: keep ref counts per role; after any change
  call `publication.setVideoQuality(...)` with HIGH if any `full` watcher exists, else LOW. When
  `document.hidden`, request LOW; restore on `visibilitychange`.
- `stream-tile.ts` gets an input `role` (default `'full'`); cards and the stream strip pass `'thumb'`
  (the tiles with `[showLoading]="false"` in `voice-room.page.ts` and `stream-view.ts`).

Checks: `npx ng build --configuration development`; smokes `smoke-stream`, `smoke-going-live`, `smoke-share-audio`,
`smoke-responsive`; `node scripts/stream-stats.mjs 20` — sender should show two active layers (main + thumb) while
one viewer watches on the stage, and the viewer's received height should equal main without switching.

### V2 — probe, modes, dialog, API

- `encode-probe.ts`: `navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: 'video/h264',
  width, height, framerate, bitrate } })` for 1080p60 and 720p60; `powerEfficient` = hardware. Cache per page.
  Any error or unsupported → software. Result: ceiling `1080p60` (hardware) or `720p30` (software, VP8).
- Replace `ScreenQuality` with a mode: `'smooth' | 'sharp'`, plus optional cap `'720p'`.

  | Mode | Ladder, top → bottom | contentHint | degradationPreference |
  |---|---|---|---|
  | smooth | 1080p60 8 Mbps → 720p60 4.5 → 720p30 2.5 | `motion` | `maintain-framerate` |
  | sharp | 1080p30 4 Mbps → 1080p15 2.5 | `detail` | `maintain-resolution` |

  Start at the highest rung allowed by probe ceiling and cap. Capture constraints follow the top rung's size and fps.
- `share-dialog.ts`: two mode cards (Smooth "games, video" / Sharp "text, apps"), a "Limit to 720p" switch, and one
  line with the probe result ("This PC can send up to 1080p 60" / "No hardware video encoder — up to 720p 30").
  Keep the audio switch, the notes and the failure flows exactly as they are.
- `media-prefs.service.ts`: migrate `streamQuality` `'1080p60'` → smooth, `'720p30'` → smooth + 720p cap.
- API `VoiceService.cs`: accept `smooth` and `sharp` in `PublicationRequest.Quality`; keep accepting `1080p60` and
  `720p30` (old clients during deploy). No migration: the column is a string. Add a case to `VoiceTests`.

Checks: `dotnet test` (stop the running API first), web build, all five smokes, plus a smoke case per forced
probe result.

### V3 — governor

`share-governor.ts`, started when the share goes live, stopped in `stopScreenShare` and `resetPublishing`.
Every 2 s read `sender.getStats()`:
- main `outbound-rtp`: `framesPerSecond`, `qualityLimitationReason`, `encoderImplementation`, `powerEfficientEncoder`
- `media-source`: `framesPerSecond` (what capture delivers)
- selected `candidate-pair`: `availableOutgoingBitrate`

Rules (a condition must hold for 6 s = 3 samples):

| Condition | Action |
|---|---|
| First sample after publish: probe said hardware but encoder is software | Jump to the software ceiling (720p30) |
| Capture fps < 75% of target, limitation `none` | Target 30 fps; one toast: cap the game's FPS or use borderless |
| Limitation `cpu` | One rung down |
| Limitation `bandwidth`, or available uplink < 1.2 × total sent | Main `maxBitrate` × 0.7 once; still limited → one rung down |
| 30 s with no limitation and uplink headroom | One rung up, never above the ceiling; a step up that fails within 20 s doubles the wait before the next try (max 5 min) |

Apply a rung with `sender.getParameters()` → edit the main encoding's `maxFramerate`, `maxBitrate`,
`scaleResolutionDownBy` (relative to the captured size) → `setParameters`. No republish, no new capture prompt.
Expose a signal `{ rung, reason }`; the streamer's own tile shows it ("Sending 720p 60 — upload limit").
Make the rule logic a pure function (samples in → action out) and unit-test it; the web app's existing unit test
setup is whatever `ng test` uses — check `apps/web/package.json` first.

Checks: unit tests; smokes; `stream-stats.mjs` with Chrome DevTools CPU throttling on the sender page
(`Emulation.setCPUThrottlingRate` via CDP) should show a step down and, after throttling stops, a step back up.

### V4 — host and playout

- `docs/runbooks/deploy.md` and `infra/scripts/poc-bootstrap.sh`: set `net.core.rmem_max` and `net.core.wmem_max`
  (LiveKit's deployment guide gives the values; check its docs via `docs/architecture/sources.md`).
- Experiment only: `receiver.jitterBufferTarget = 120` on Smooth screen video. Keep it only if the stats panel's
  freezes/dropped numbers improve on a real link and sound stays in sync.

### V5 — not now

OBS → WHIP → LiveKit Ingress. Needs its own ADR and the user's go.

## Done means

On two real Windows PCs, 10 minutes of a game capped at the display's refresh rate:
- GPU-encoder PC: Encoder row says Hardware; main layer stays ≥ 55 fps; a viewer on a healthy link sees no
  resolution switch and 0 freezes.
- PC without one: steady 30 fps, and the dialog said so before going live.

Only the user can run this. Give them the exact things to read off the stats panel.

## Deploy note for the user

V1–V3 need `dc build api edge && dc up -d api edge` on the VPS, no migration. V4 needs the sysctl change on the host.
