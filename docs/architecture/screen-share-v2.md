# Screen share v2 — design proposal

Status: **V0–V3 built 2026-11-10** (see §5 for what building it changed); V4 open, V5 optional. Replaces the publish/receive pipeline of slice S5. The control plane
(leases, publication reservations, source grants, caps of 4 screens) stays as it is.

Problem reported: streams do not hold more than about 30 fps and are very unstable.

## 1. Why the current pipeline is unstable

Found by reading the code; not yet measured on a real gaming PC (step V0 does that first).

| # | What the code does today | Effect |
|---|---|---|
| 1 | No `videoCodec` is set on publish (`media-session.service.ts` `startScreenShare`), so livekit-client uses its default, **VP8**. Windows GPUs do not encode VP8, so Chrome encodes in **software**. | The CPU that runs the game also runs the encoder. |
| 2 | Three simulcast layers: 1080p60 + **720p60** + 360p15. | About 183 million pixels/s of software encoding, three encoders. When the CPU falls behind, Chrome cuts frame rate or resolution — 60 becomes 20–35. |
| 3 | A software encoder needs the captured frame copied from the GPU to RAM and converted, 60 times a second at 1080p. | More load on the same CPU and on the GPU the game is using. |
| 4 | One fixed ladder (11.4 Mbps upload) for every PC and every uplink. Nothing checks what the PC or connection can do. | On a ~10 Mbps uplink the browser keeps switching layers on and off. |
| 5 | Viewers get a layer picked from the size of the video element (`adaptiveStream`). A normal stage is under 1280 px wide, so most viewers sit on the 720p60 layer and jump to 1080p on fullscreen or resize. | Every switch needs a keyframe; a 1080p keyframe is a bitrate spike, which can trigger the next switch down. |
| 6 | Nothing reacts to the encoder's own report (`qualityLimitationReason`). `maintain-framerate` only chooses what degrades. | The stream wobbles instead of settling on something it can hold. |
| 7 | No check of how viewers are connected. ICE over TCP or TURN/TLS at 8 Mbps stutters by nature. | Unknown today — may explain some friends' experience. |

VP9/AV1 SVC is not the fix: livekit-client 2.23 itself notes Chrome limits screen-share SVC (L1T3) to 5 fps and has
encoding bugs with L3T3, and no consumer GPU encodes SVC in Chrome, so it would be software again.

## 2. Design

Five rules:

1. **One hardware encode carries the stream.** H.264 on the GPU's encoder (NVENC / Quick Sync / AMF), which is a
   separate chip from the one rendering the game.
2. **The profile is chosen per streamer**, from what their PC can encode, not from a fixed preset.
3. **A closed loop holds it steady**: the publisher measures and steps down (or back up) on purpose, with hysteresis.
4. **Viewers ask for a layer explicitly.** No layer changes from window resizes.
5. **The UI says what is really being sent and why.**

### 2.1 Encode probe — `core/media/encode-probe.ts` (new)

At Go Live, before the picker: `navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType:
'video/h264', width, height, framerate, bitrate } })` for 1080p60, 720p60. `powerEfficient: true` means a hardware
encoder. Result cached per session.

- Hardware H.264 → ceiling 1080p60.
- No hardware encoder → ceiling **720p30, VP8 software**, and the dialog says so.

After publishing, the first stats sample checks `encoderImplementation` / `powerEfficientEncoder` on the main layer. If
Chrome did not use hardware after all, the governor drops to the software ceiling at once.

### 2.2 Modes instead of quality presets

| Mode | For | Ladder (top → bottom) | Hint / degradation |
|---|---|---|---|
| **Smooth** (default) | games, video | 1080p60 8 Mbps → 720p60 4.5 → 720p30 2.5 | `motion`, maintain-framerate |
| **Sharp** | code, documents, apps | 1080p30 4 Mbps → 1080p15 2.5 | `detail`, maintain-resolution |

Optional manual cap in the dialog ("limit to 720p") for people who know their upload is small.

### 2.3 Layers

| Layer | Content | Who receives it |
|---|---|---|
| main | current rung of the ladder | stage, grid tile, fullscreen, pop-out |
| safe | 720p30, 1.5 Mbps (only when main is above 720p30) | a viewer whose own link cannot take main (SFU decision) |
| thumb | 360p15, 0.25 Mbps | participant cards, stream strip |

Dynacast (already on) stops encoding layers above what anyone receives. Measured: while someone watches the main
layer, the SFU keeps the lower ones on too (they are its fallback), so the usual case is all three — about 155
million pixels/s on the GPU's encoder instead of 183 on the CPU.

Publish options: `videoCodec: 'h264'`, `backupCodec: false` (targets are Chrome/Edge desktop; all decode H.264),
`simulcast: true`, `screenShareEncoding` = main, `screenShareSimulcastLayers` = [thumb, safe].

### 2.4 Share governor — `core/media/share-governor.ts` (new)

Every 2 s while live, from the sender's `getStats`: main layer `framesPerSecond`, `qualityLimitationReason`,
`encoderImplementation`; `media-source.framesPerSecond` (what capture delivers); `availableOutgoingBitrate`.

| Condition (held 6 s) | Action |
|---|---|
| Capture delivers < 75% of target fps, encoder not limited | Capture is starved (game uses the whole GPU). Set target 30 fps — steady 30 beats jittery 45. One-time tip: cap the game's FPS or use borderless. |
| Limited by `cpu` | One rung down. |
| Limited by `bandwidth`, or available uplink < 1.2 × what is sent | Main bitrate to 70%; if still limited, one rung down. |
| 30 s clean with headroom | One rung up, never above the ceiling. A failed step up doubles the wait before the next try (max 5 min). |

Steps are applied with `RTCRtpSender.setParameters` (`maxFramerate`, `maxBitrate`, `scaleResolutionDownBy`): no
renegotiation, no new capture prompt. The streamer's tile shows the rung and the reason ("Sending 720p60 — upload
limit"). Viewers already see the measured "720p · 60 fps" badge; no server message needed.

### 2.5 Viewer side

- `watchVideo(stream, role)` with role `full` or `thumb`; the highest role among mounted tiles is requested with
  `publication.setVideoQuality`. `adaptiveStream` is turned off (explicit subscriptions already cover "only receive
  what is on screen"); a hidden tab drops to `thumb`.
- Stats panel gains two rows: **Encoder** (hardware/software, streamer side) and **Transport** (UDP direct / TCP /
  relay, both sides).
- Experiment, keep only if measured better: `jitterBufferTarget` ≈ 120 ms on Smooth streams to absorb bursts.

### 2.6 Server and API

- `PublicationRequest.Quality` accepts `smooth` / `sharp` (old values map: `1080p60` → smooth, `720p30` → smooth with
  720p cap). Nothing else changes in `VoiceService`.
- Host: raise UDP socket buffers (`net.core.rmem_max` / `wmem_max`), as LiveKit's deployment guide advises; check CPU
  steal on the VPS during a stream (ops-monitor already samples it).
- LiveKit stays v1.9.1; no config change required for H.264.

### 2.7 What a browser cannot do (later, optional)

A browser cannot capture exclusive-fullscreen games or hook into a game the way native clients do. If v2 is still not
enough for a specific friend: **OBS → WHIP → LiveKit Ingress** (passthrough, no transcoding) publishes into the same
room; the API issues a per-user stream key tied to the screen reservation. Adds one service; needs its own ADR.

## 3. Build order

| Step | Content | Proves |
|---|---|---|
| V0 | Stats panel rows Encoder + Transport; one real game share on the current build, note codec / limited-by / fps | The diagnosis in §1 |
| V1 | H.264, new layers, `watchVideo` roles, adaptiveStream off | Largest gain, small diff |
| V2 | Probe, Smooth/Sharp modes, dialog, API quality values | Right profile per PC |
| V3 | Governor + streamer-side status text | Stability under load |
| V4 | Host UDP buffers, jitter-buffer experiment | Remaining stutter |
| V5 | (optional) WHIP ingest | Fullscreen-exclusive games |

Acceptance for V1–V3, two real Windows PCs, 10 minutes of a game capped at the display's refresh rate:
hardware-encoder PC — main layer fps 5th percentile ≥ 55, no layer switch at a viewer on a healthy link, 0 freezes;
software-only PC — steady 30 fps.

## 4. Risks

- Chrome may not pick the hardware H.264 encoder on some PCs (old GPU, driver). Covered by the probe plus the
  post-publish check; such PCs get the software ceiling.
- Hardware H.264 rate control overshoots more than libvpx. The governor's bitrate rule and the 8 Mbps cap bound it.
- If the game is uncapped and takes 100% of the GPU, Chrome's capture itself drops frames. No encoder choice fixes
  that; the governor settles on 30 fps and tells the streamer.

## 5. What building it changed (2026-11-10, measured on an RTX 4070 PC with Edge)

- **LiveKit 1.9.1 answers publishers, and offers viewers, only H.264 Constrained Baseline level 3.1.** Windows GPU
  encoders are used for High profile only; with Baseline the browser used OpenH264 in software and, at level 3.1, never
  sent the 720p/1080p layers at all. Publishing real High profile (reordering the answer) made the SFU fall back to
  its VP8 backup for every viewer. What works: the answer's first H.264 entry is rewritten to High profile level 5.0
  before the browser sees it (`encode-probe.ts` `preferHighProfileH264`). The browser then encodes High on the GPU
  under the payload type the SFU chose; the SFU forwards it as-is; Chrome/Edge decode it (D3D11). Result: all three
  layers on "NVIDIA H.264 Encoder MFT", viewer at 1080p.
- **The probe must ask per profile.** `mediaCapabilities.encodingInfo` says `powerEfficient: false` for plain
  `video/H264` and true only with a High-profile `profile-level-id`, so the probe tries every profile the browser can send.
- **Start bitrate.** With H.264 the bandwidth estimate started at the browser default and viewers sat on 360p for
  12–18 s. The rewritten answer carries `x-google-start-bitrate=4000`; the main layer now arrives in 4–8 s.
- **Software ladder is VP8, not H.264** (libvpx holds 720p30 better than OpenH264), and has no "safe" layer.
- **Not proven by automation: 60 fps.** Playwright's tab capture delivers about 20 fps on this PC whatever is asked,
  so the governor's "screen delivers ~30 fps" rule was exercised but a 1080p60 run was not. Needs a real game share.
- **A viewer that is not Chrome/Edge** (Firefox, Safari) is told Baseline and receives High. Out of the supported
  targets; if it ever matters, turn the rewrite off for rooms with such a viewer.
