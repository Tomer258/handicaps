# Browser media feasibility and compatibility

**Checked 17 October 2026.** This is a documentation-based support assessment, not a laboratory compatibility certification. Phase 0 records exact browser, Windows, driver, device, and LiveKit versions with evidence from two different computers.

## What can be promised

A web application can offer monitor, application-window, and browser-tab capture through the browser's picker. It cannot silently choose an arbitrary game/window, keep permanent screen-sharing permission, or guarantee a requested frame rate. `getDisplayMedia()` requires a secure context and direct user activation, and may return video without audio. `min`/`exact` constraints must not be used in its initial capture constraints. [API and security rules](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

Chrome 141 and Edge 141 documented `windowAudio` values `exclude`, `window`, and `system`. They also documented `restrictOwnAudio`, intended to exclude audio originating in the capturing document from system capture. These are significant changes from older articles claiming that only browser-tab audio is possible. API availability is not proof that a particular Windows build exposes an isolated game-audio source. [Chrome release notes](https://developer.chrome.com/release-notes/141), [Edge release notes](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/release-notes/141).

## Compatibility matrix

“Conditional” means detect the capability, inspect the returned tracks, and verify the selected source on the actual device. “No product guarantee” is a scope decision, not a claim that every version of that browser lacks the feature.

| Browser / OS | Monitor or window video | Individual browser-tab video | Tab audio | Full system audio | Audio isolated to selected window | MVP support |
|---|---|---|---|---|---|---|
| Current Chrome / Windows | Supported, picker-controlled | Supported | Supported when selected and consented | Supported baseline, conditional on picker/OS/policy | Conditional; `windowAudio` is documented, isolation needs real testing | Primary release target |
| Current Edge / Windows | Supported, picker-controlled | Supported | Supported when selected and consented | Supported baseline, conditional on picker/OS/policy | Conditional; documented by Microsoft, test exact Windows/browser combination | Primary release target |
| Chrome or Edge / macOS | Conditional on OS screen-recording permission | Supported Chromium capability | Supported Chromium capability | Conditional; do not infer from Windows results | Conditional, OS/version dependent | Voice/chat and media viewing; publishing best effort until certified |
| Chrome or Edge / Linux | Conditional on desktop/session capture backend | Supported Chromium capability | Supported Chromium capability | No product guarantee; offer video-only fallback | No product guarantee | Voice/chat and viewing; publishing best effort |
| Firefox desktop | Monitor/window capability subject to picker | Do not promise Chromium's dedicated tab picker behavior | No product guarantee | No product guarantee | No product guarantee | Chat/voice/viewing; show capabilities rather than fake audio success |
| Safari / macOS | Conditional desktop capture | Do not promise Chromium's tab picker | No product guarantee | No product guarantee | No product guarantee | Secondary chat/voice/viewing testing |
| Mobile browsers | Not a release target for screen publishing | Not a release target | Not a release target | Not a release target | Not a release target | Responsive text UI; viewing/voice only after device tests |

The positive Windows target is a proposed supported configuration. Non-Windows rows deliberately avoid universal claims because feature strings can exist while OS capture paths differ. Chrome's own screen-sharing guidance identifies the source and privacy controls; its older prose must be read alongside the newer release notes. [Screen-sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls/), [capture API reference](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

## Capture and publication design

1. Show choices such as “Share game/window”, “Share tab”, and “Share screen”. Explain that the browser makes the final source selection. Prefer a game/window with isolated audio when available; use a tab for web content.
2. In the click handler, invoke capture immediately with video and optional audio. Request ideal 1920×1080/60 for the high preset and an appropriate motion content hint, but inspect actual video settings afterward. For documents/text, prefer detail over motion and reduce FPS.
3. Request `systemAudio: include` only in an explicit system-audio mode. For a game/window prefer `windowAudio: window`; never silently broaden to system capture when isolation fails. Exclude the app's own tab from the picker where supported. These options guide a user agent rather than select a source secretly.
4. Request own-document audio exclusion where supported. Capability detection is advisory. The receipt of an audio track and a clean test are the actual success conditions. A capture with no audio gets a visible “Video only” status and a retry/fallback choice.
5. Reserve the publication with the backend. Publish video as screen share and audio as screen-share audio through LiveKit. If a helper omits a newly added browser option, invoke `getDisplayMedia()` directly and wrap the returned MediaStreamTracks with the pinned SDK. Do not invent unsupported SDK configuration fields. [LiveKit capture options](https://docs.livekit.io/reference/client-sdk-js/interfaces/ScreenShareCaptureOptions.html).
6. Keep capture and publication lifecycles separate. Permission failure or denial stops all orphaned tracks; network interruption may retain live capture during a bounded retry; ended capture never restarts without another user gesture.

The product status distinguishes captured resolution/FPS, encoded resolution/FPS, configured bitrate ceiling, current send rate, and received stream quality. “1080p/60 requested” is not “1080p/60 delivered.” High-motion games may look poor at 8 Mbps; raise bitrate only after capacity planning, or use 720p/60 or 720p/30. Protected/DRM surfaces and some exclusive-fullscreen games can be black or inaccessible; try borderless/windowed mode and explain the limitation.

## Feedback is the key audio risk

There are two different loops. Acoustic echo is a loudspeaker reaching a microphone; headphones and microphone AEC help. Digital loopback is system capture including remote voice, the app's soundboard output, or notification sounds, then publishing them back into the room. Headphones do not prevent this, because the captured audio is taken before the sound reaches the headphones.

Preferred order:

1. Capture only the game/window audio when the browser can isolate it.
2. When system capture is necessary, request and test `restrictOwnAudio`. All app room playback should originate in the same document so the exclusion can cover it. The constraint cannot be treated as universal across browsers. [Own-audio constraint](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/restrictOwnAudio).
3. If exclusion is unavailable or fails, use tab audio for web content or a separately routed audio device/virtual loopback configured by the user, with the call output outside that captured mix. This can require OS configuration/software and is not the zero-install browser path.
4. Otherwise allow video-only sharing and keep microphone voice. Label the limitation before publishing; do not silently provide a feedback-prone stream as successful game audio.

Do not apply speech noise suppression/AGC to game or soundboard tracks; it may distort music and effects. Keep microphone processing independent. Do not monitor the local screen audio into the app's output, because the original application already plays it. The clicker hears server soundboard audio once through normal receiving playback; no optimistic duplicate local playback.

An automated energy/correlation check can help identify recapture, but it is a warning and diagnostic tool, not a guaranteed acoustic feedback detector. The actual release test has client A sharing a game tone, client B speaking a different tone, and a soundboard effect. Client B must receive A's game and microphone without receiving its own voice or a second copy of the soundboard through A's screen track.

## Autoplay and output devices

Join is an explicit user action that resumes the AudioContext and starts allowed audio playback. Catch rejected media `play()` promises and LiveKit audio-playback status events; show an “Enable audio” action. A connected or subscribed client can still be silent because it is deafened, muted, or autoplay-blocked. “Everyone hears it” means every connected, authorized listener with playback enabled and soundboard volume above zero, with normal packet loss caveats.

The common receive mixer uses a Web Audio graph with per-track/per-class gain and a final limiter. Prefer `AudioContext.setSinkId` when supported. If only element `setSinkId` is available, route the mixer through one MediaStream destination into one selected-sink output element and disconnect the default output path to prevent double playback. Test this path's latency and microphone AEC. Where no output switching API works, retain the system default. [MediaStream destination](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaStreamDestination), [element output selection](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId).

## Native-only or conditional requirements

| Desired behavior | Browser-only commitment | Native companion trigger |
|---|---|---|
| Favorite sound key while this page is focused | Yes, configurable, excluding form fields and browser-reserved combinations | None |
| Sound key while a game is focused | No general website API guarantee | OS global hotkeys / native helper |
| Push-to-talk globally | No general website guarantee | Native registration of hotkeys |
| Reliable per-process game audio everywhere | Conditional Chromium/OS support | OS audio-loopback/process capture integration |
| Capture without repeated browser selection | No | Native UX with explicit permissions; not part of MVP |
| Guaranteed background capture when browser/OS suspends | No | Native lifecycle design, still subject to OS limits |

A browser extension can expose extra APIs but is an installation and maintenance burden and still has browser/OS limitations. It is not an assumed universal workaround. If a native companion becomes necessary, keep Angular as the main UI and add a narrowly scoped signed helper; that is a separate ADR and scope approval.

## Phase 0 evidence record

Record the exact Chrome/Edge build, Windows release/build, GPU/driver, selected surface, returned audio/video track settings, permissions, measured send/receive statistics, codec, CPU usage, start latency, autoplay behavior, feedback result and stop/reconnect result. Test monitor, window and tab independently. Documentation proves API design; these records certify the product configuration.
