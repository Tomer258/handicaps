# Soundboard architecture

**Mandatory MVP feature.** Chosen design: server-authorized playback, a small server-side RTC publisher, separate audio tracks by triggering user, and client-side independent receive controls. This document defines the normal path and the failure semantics.

## 1. Alternatives

| Approach | Audio path and latency | Controls / synchronization | Costs and reliability | Decision |
|---|---|---|---|---|
| Browser mixes mic plus sound | Web Audio sources → gain/mixer → MediaStream destination → one outgoing mic-like track; potentially quick after warm-up | Listeners cannot independently separate mic and effect; mic mute/permission becomes confusing; speech processing may harm effects | No extra server encoder, but sender tab owns timing and failure; server cannot enforce which bytes are mixed | Reject for core requirement |
| Browser publishes a separate effect track | Approved asset → AudioContext → MediaStreamAudioDestinationNode → LiveKit LocalAudioTrack → SFU | Separate volume/mute possible; ordinary RTC receiver jitter differences | Low server compute, extra sender publication; modified client can publish arbitrary content or ignore Stop/cooldowns | Viable simpler trusted-clients prototype, not selected |
| Server commands synchronized local playback | REST permission check → SignalR command → each browser downloads/decodes/schedules file | Independent volume and good cached quality; late/missing commands, clock error and autoplay produce divergent playback | Low media bandwidth, cache/decode work per client; no actual soundboard media in LiveKit; external participants hear nothing | Does not meet the selected shared-media contract |
| Server RTC publisher | REST permission check → normalized file → server RTC audio source → SFU → all listeners | Separate per-actor effects, authoritative start/stop, local volume; jitter means not sample-synchronous | One narrow worker, one bot participant per occupied room, at most two active encoders installation-wide | Choose |

All options must handle browser autoplay on the receiving side. Publishing audio does not bypass a blocked speaker. “Synchronized” in RTC means people hear the same live performance within network/jitter variation; it does not mean sample-accurate playback across computers.

The server publisher is justified by required stop/moderation, upload validation, microphone-independent operation, and per-user soundboard mute. It adds one runtime language but avoids fragile permission schemes around client-produced arbitrary tracks. Do not add the LiveKit Agents framework, an LLM, Redis, or a media transcode farm.

## 2. Exact audio and control paths

**Audio:** approved normalized 48 kHz, 16-bit stereo PCM WAV on private disk → publisher's bounded PCM reader → 20 ms `AudioFrame` chunks → Python RTC `AudioSource` → `LocalAudioTrack` → Opus/WebRTC publication → LiveKit SFU → receiving browser's decoded MediaStreamTrack → actor gain × soundboard gain → shared output limiter/master gain → chosen output device.

**Control:** Angular play action → authenticated REST with voice lease, sound ID/version and request ID → permission, membership and quota transaction → internal publisher command → track registration and playback-start acknowledgement → SignalR state event to the channel. SignalR transports IDs and state, not the audio waveform.

LiveKit documents server-side PCM publication through AudioSource and LocalAudioTrack. The SDK handles encoding and RTC transmission; file chunking and resampling are application responsibilities. Normalize once at upload to avoid per-play decoding of untrusted files. [Raw media publication](https://docs.livekit.io/transport/media/raw-tracks/), [Python AudioSource](https://docs.livekit.io/reference/python/livekit/rtc/audio_source.html).

The worker joins only occupied voice rooms, with subscribe disabled. It never receives or records users' microphones, cameras, or screens. Its JWT is scoped to one room and publication only, with no room-admin capabilities. Browser clients get no worker secret. The API verifies the worker identity and publishes a track registry mapping `trackSid → actorUserId, audioClass, roomGeneration`.

### Separate tracks are essential

Use one long-lived sound track per actor who invokes the soundboard in the current room, with at most fifteen tracks and only two carrying effects at once across the installation. Lazily create a track at first use, keep it until the actor leaves or the room empties, and pause/mute its publication when idle after draining audio. Measure the pinned SDK's unmute/preroll behavior; do not stream continuous stereo silence to every client. A small bounded warm-up and subscription lead-in protects the first syllable.

Each track name contains an opaque actor identifier; the authoritative mapping comes from the backend/verified worker, not an arbitrary client's name. Publish worker tracks with the SDK's supported custom/unknown source and no human source restriction on this trusted worker token. The Phase 0 test must verify multiple custom audio tracks, source metadata and auto-subscription. Human JWTs remain restricted to microphone/camera/screen sources. Never misuse the user's microphone source to hide a soundboard track.

One mixed room-wide track would make “mute effects from user X” impossible without also muting everybody else's effects. Per-actor tracks solve that. A fixed pool of two shared tracks would require race-prone attribution changes; do not choose it just to save idle track metadata. If the pinned SDK fails the fifteen-track arrangement, rework the publisher contract in an ADR before implementing the UI.

The triggerer receives their sound from the server like everyone else. Do not also call local preview. Late joiners can hear the remaining live tail of an in-progress effect, but never replay it from the beginning. A reconnect likewise does not replay old commands.

## 3. Command state and moderation

`SoundPlaybackCommand` contains request ID, playback ID, room generation, voice lease, actor, immutable asset version/hash, created/expiry timestamps, state and worker epoch. States are `accepted → starting → playing → completed`, with `rejected`, `stopped`, `expired` and `failed` terminal alternatives. `accepted` is a committed request; `playing` follows the worker's actual start acknowledgement. Neither means that every listener has rendered audio.

One backend serializes reservations per room and for the installation-wide limit. Check that the account/session is active, the actor has an active verified voice lease in that room, the sound is ready and belongs to the allowed library, and the actor has PlaySoundboard. Apply cooldowns and concurrency within the same transaction so simultaneous requests cannot all pass an in-memory check.

Proposed limits: five seconds per effect; one effect per actor; two active effects installation-wide; two-second minimum interval; six accepted starts per user per minute and twelve per room per minute. Count accepted starts even if the user stops immediately. Return 429 with retry time for rate limits and a distinct busy result for concurrency. Successive clicks after completion are supported; the MVP does not silently queue a backlog of sounds.

The publisher's internal endpoint receives an allowlisted command with a short start deadline, normally two seconds. It validates its worker epoch, command identity, room generation and asset hash; it cannot accept a client-supplied path or URL. Keep an idempotency cache and a database command record. Duplicate delivery returns prior state. After an ambiguous worker crash, mark uncertain playback failed and do not retry it, accepting a missed sound rather than replaying one unexpectedly. Exactly-once audible output cannot be guaranteed across crashes.

Stop is a separate authorized command. An actor can stop their own effect, moderators can stop any effect, and Stop All is restricted to moderation. Cancel the PCM feed, clear the SDK audio queue, apply a short fade where possible, then mute the track. Keep the queue near 100 ms rather than buffering the entire file; already transmitted/decoded audio cannot be recalled. Target stop-to-silence p95 below 400 ms on the certified configuration, measured rather than guaranteed.

A stop arriving before start makes the command terminal and prevents a later retry from playing it. On permission revocation, room switch, session revocation or actor departure, stop their active effect. Library deletion disables new starts immediately and cancels active use; file garbage collection waits until references are released.

Commands expire quickly, while diagnostic records remain for 24 hours. This is operational state, not permanent playback history. Retain aggregated counters and moderation audit events longer without recording audio. Worker heartbeats and lease checks fail closed for new starts; if the API becomes unreachable, finish or stop the current effect within its five-second bound and accept no new command.

## 4. Upload and asset lifecycle

| Property | Default |
|---|---|
| Inputs | MP3, PCM WAV, OGG containing Opus or Vorbis; validate actual codec/container |
| Maximum upload | 5 MiB; streaming body cap at edge and API |
| Duration | 0.1–5.0 seconds decoded duration |
| Library quota | 300 ready sounds / 500 MiB normalized data initially |
| Per-user quota | 30 owned sounds; administrators can adjust |
| Name | 1–60 characters; plain text |
| Icon | Optional Unicode emoji; no arbitrary SVG/HTML |
| Canonical output | 48 kHz, stereo, signed 16-bit PCM WAV, metadata stripped |
| Normalization | Proposed -18 LUFS target, true peak no greater than -3 dBTP; reject invalid analysis |

At five seconds, canonical stereo PCM is approximately 960,000 bytes plus the WAV header. The extra disk space is trivial for 300 sounds and gives one simple playback path. MP3/OGG input compatibility does not require every receiving browser to decode those originals: receivers hear WebRTC Opus, while previews use normalized PCM WAV. Local pre-upload preview uses browser decoding when supported; if unavailable, the UI says preview requires validation and offers the normalized preview before publication.

Upload creates a private pending asset and a database validation job. The API streams to a random quarantine filename without trusting its extension. A validator container with no network, no secrets and no Docker socket polls only trusted job descriptors in its mounted spool. Untrusted uploads cannot create those descriptors. It runs FFmpeg/ffprobe as an unprivileged subprocess with timeout, PID/memory/CPU limits, one processing job at a time, and restrictive protocol/demuxer selection. Reject malformed files, video streams, unexpected stream counts, excessive channels/sample rate, truncated decode, NaN metadata, silence-only content and oversized decoded output. Parse metadata only as a hint; enforce the full decode boundary.

Normalize and peak-limit offline. Extremely short effects may not provide meaningful integrated loudness; use a bounded peak/RMS policy and listening review instead of blindly amplifying a near-silent file. Recheck final true peak, samples/duration and checksum after processing. FFmpeg supports loudness processing, but chosen thresholds are this application's policy. [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [upload security](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

The validator writes an immutable output and result descriptor atomically. The API verifies expected paths, size/hash and job state before moving the asset to ready and exposing it. Rename modifies metadata; replacing sound bytes creates a new immutable version. No shell interpolation of names/paths. Remove rejected/quarantined sources within 24 hours and unused successful originals after validation. The publisher mounts only finalized sound storage read-only.

Owner may rename/delete their sound if granted ManageOwnSounds; administrator may manage any sound. UploadSoundboard and PlaySoundboard are separate permissions. A server library is inherited into voice channels unless an explicit channel restriction disables playback. Cached metadata is invalidated by versioned SignalR events. Favorites are private preferences, not permission grants.

## 5. Volume and mixing contract

| Control | Applied to | Affects outgoing microphone? |
|---|---|---|
| Microphone mute/input gain | Local microphone publication | Yes |
| Voice class volume | All received human microphone tracks | No |
| Individual voice volume | One participant's received microphone | No |
| Screen audio volume | One screen stream and optional screen class master | No |
| Soundboard volume | Received soundboard class | No |
| Mute effects from user X | Soundboard track attributed to X | No |
| Overall output / Deafen | Final receive output graph | Deafen also requests local mic mute |

For an ordinary received track, effective gain is master × class × track/actor preference × mute gate. All gains default at or below unity. The first version does not offer amplification above 100%; adding it needs limiter/headroom tests. Soundboard starts at a conservative default and uses normalized files, a combined soundboard limiter, then the final master limiter. Two individually safe tracks can sum into clipping, so per-file normalization alone is insufficient.

Optional local ducking reduces screen and soundboard playback by approximately 6 dB while a human microphone is active, with short attack and a smooth release. Do not automatically duck voices under a sound. Never route the receive graph into microphone or soundboard publication. The system-audio recapture mitigation from [browser research](browser-media-research.md) remains mandatory.

Web Audio is appropriate for gain, local preview, metering and output limiting. `MediaStreamAudioDestinationNode` creates a stream from an audio graph but does not send it to a room by itself. In the rejected browser-publisher alternative its audio track must be explicitly published through LiveKit. In the chosen design it can be used only for selected-output routing; server RTC publication carries the soundboard waveform.

## 6. UI and state ownership

`SoundboardPanel` composes `SoundSearch`, `SoundGrid`, `SoundTile`, `FavoriteToggle`, `SoundUploadDialog`, `SoundPreviewPlayer`, and `SoundboardVolumeControl`. The grid displays name, emoji, duration, ownership/favorite and playing state. The dock stays usable while the user reads another text channel. Upload and management actions respect effective permissions but rely on the API for enforcement.

Root `SoundboardStore` owns the current server catalog, favorites and playback-state view; root `AudioOutputService` owns local volumes and per-actor mute. A feature-scoped upload facade owns form/progress/preview cleanup. Previews stop when the dialog closes and never start a room playback. Route navigation must not destroy receiver soundboard tracks.

Focus-only shortcuts use configurable combinations, avoid input/textarea/contenteditable, respect repeat suppression and call the same rate-limited API as clicking. Display “Works while this app is focused.” Global hotkeys while gaming are outside browser-only MVP. Keyboard navigation, announcements and accessibility are specified in the main architecture.

## 7. Latency, failure and acceptance

Planning targets, not benchmark results: warm click-to-remote-audio p95 ≤500 ms on the selected host; cold first-play p95 ≤1 second; stop p95 ≤400 ms. Decompose telemetry into request RTT, authorization/queue delay, track publication, encoder and receiver jitter. Preload the normalized file in bounded worker memory and reuse tracks to reduce warm delay; do not hide cold delay by playing only to the clicker.

Worker failure affects the soundboard while microphone/screen media continue. Show the unavailable state; release active reservations through reconciliation. Backend failure prevents new play commands while an already started effect ends within its cap. LiveKit restart interrupts every media track; reconnect with new authorization and empty playback state. No old effect is replayed.

Release tests must prove audible sound at a separate browser client with the sender's microphone denied, active microphone plus sound, screen audio plus sound, per-user muting, two concurrent actors, stop races, autoplay denial, lost acknowledgements, reconnect mid-effect, and cleanup without leaked tracks. Unit tests that observe a local AudioContext alone are not proof of the feature.
