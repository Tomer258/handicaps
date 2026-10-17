# Research sources and evidence limits

Primary sources checked on **17 October 2026**. Publication dates and page retrieval dates are different; release documentation can remain accurate long after publication. Links below support product capabilities/specifications. Design choices, capacity formulas, target latencies and resource budgets are the author's proposals, not measured vendor results.

## Browser and frontend

| Source | Used for |
|---|---|
| [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) | Optional audio, user activation, permission persistence and capture hints |
| [Chrome 141 release notes](https://developer.chrome.com/release-notes/141) | windowAudio and restrictOwnAudio feature introduction |
| [Microsoft Edge 141 platform notes](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/release-notes/141) | Independent Microsoft documentation of those audio options |
| [Chrome privacy-preserving screen sharing](https://developer.chrome.com/docs/web-platform/screen-sharing-controls/) | Surface choices, own-tab exclusion and system-audio privacy |
| [MDN restrictOwnAudio](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/restrictOwnAudio) | Conditional own-document audio exclusion |
| [MDN MediaStream destination](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaStreamDestination) | Producing an audio stream from a Web Audio graph |
| [MDN setSinkId](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId) | Output-device selection constraints |
| [Angular releases](https://angular.dev/reference/releases) | Supported major selection |
| [Angular compatibility](https://angular.dev/reference/versions) | Node/TypeScript/RxJS compatibility |
| [Angular Signals](https://angular.dev/guide/signals) | Reactive state primitives |
| [Angular zoneless](https://angular.dev/guide/zoneless) | Change-detection integration |

## Backend, media and security

| Source | Used for |
|---|---|
| [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) | ASP.NET/.NET 10 LTS baseline |
| [ASP.NET cookies](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/cookie?view=aspnetcore-10.0) | Cookie/Data Protection behavior and revocation validation |
| [SignalR authentication/authorization](https://learn.microsoft.com/en-us/aspnet/core/signalr/authn-and-authz?view=aspnetcore-10.0) | Connection authentication and expiration behavior |
| [SignalR groups](https://learn.microsoft.com/en-us/aspnet/core/signalr/groups?view=aspnetcore-10.0) | Groups as routing rather than authorization/durable state |
| [PostgreSQL version policy](https://www.postgresql.org/support/versioning/) | Supported database baseline |
| [LiveKit SFU internals](https://docs.livekit.io/reference/internals/livekit-sfu/) | Single-node dependency boundary and forwarding architecture |
| [LiveKit tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/) | Room grants, refresh and Cloud/self-hosted revocation distinction |
| [LiveKit RoomService](https://docs.livekit.io/reference/other/roomservice-api/) | Typed HTTP/Twirp integration and participant administration |
| [LiveKit raw media](https://docs.livekit.io/transport/media/raw-tracks/) | PCM AudioSource/LocalAudioTrack server publication |
| [Python AudioSource reference](https://docs.livekit.io/reference/python/livekit/rtc/audio_source.html) | Bounded audio queue and interruption behavior |
| [LiveKit screen sharing](https://docs.livekit.io/transport/media/screenshare/) | Screen publication lifecycle and audio limitations |
| [JS capture options](https://docs.livekit.io/reference/client-sdk-js/interfaces/ScreenShareCaptureOptions.html) | SDK capture option surface; avoid assuming unimplemented options |
| [JS LocalAudioTrack](https://docs.livekit.io/reference/client-sdk-js/classes/LocalAudioTrack.html) | Custom browser-track alternative |
| [LiveKit track subscriptions](https://docs.livekit.io/transport/media/subscribe/) | Explicit subscriptions and receiving media |
| [LiveKit codecs and simulcast](https://docs.livekit.io/transport/media/advanced/) | Layering, dynacast and audio settings |
| [LiveKit encryption](https://docs.livekit.io/transport/encryption/) | Distinguishing transport protection from optional E2EE |
| [LiveKit benchmarks](https://docs.livekit.io/transport/self-hosting/benchmark/) | Published benchmark hardware and CLI test limitations |
| [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/) | Host networking, embedded TURN and deployment concerns |
| [LiveKit ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/) | UDP mux, ICE/TCP, signaling and TURN exposure |
| [LiveKit virtual-machine setup](https://docs.livekit.io/transport/self-hosting/vm/) | Caddy/Compose deployment and TCP 443 use |
| [LiveKit deploy repository](https://github.com/livekit/deploy) | Established Caddy Layer 4 tooling |
| [LiveKit configuration sample](https://github.com/livekit/livekit/blob/master/config-sample.yaml) | TURN external TLS setting; match pinned template |
| [Caddy forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth) | Building block for proposed signaling admission, not proof of end-to-end integration |
| [mediasoup documentation](https://mediasoup.org/documentation/v3/) | Alternative media toolkit evaluation |
| [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html) | Loudness processing capabilities |
| [OWASP file uploads](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) | Validation and isolation threat considerations |
| [Ubuntu release lifecycle](https://ubuntu.com/about/release-cycle) | Supported LTS host choice |

## Hosting

| Source | Evidence quality / limitation |
|---|---|
| [OVH worldwide VPS](https://www.ovhcloud.com/en/vps/) | Live retrieved public range/specs and starting prices; exact regional checkout/term not obtained |
| [Hetzner cost-optimized cloud](https://www.hetzner.com/cloud/cost-optimized/) | Retrieved machine specs/20-TB allowance; dynamic prices missing and page showed unavailable |
| [Hetzner June 2026 adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) | Official explicit EUR/USD price table; excludes VAT and IPv4 |
| [Hetzner primary IPs](https://docs.hetzner.com/cloud/servers/primary-ips/overview/) | Published IPv4 add-on rate |
| [Contabo US pricing](https://contabo.com/en-us/pricing/) | Official indexed current offer; direct retrieval repeatedly failed; confirm locale/tax/term |
| [Contabo global pricing](https://contabo.com/en/pricing/) | Official indexed offer with different displayed tax/locale total |
| [Contabo product documentation](https://docs.contabo.com/docs/products/cloud-vps/) | Older generation labels conflict with current pricing page; not used to mix specifications |
| [Kamatera pricing](https://www.kamatera.com/pricing/) | Retrieved presets, allowance/overage and accounting condition; exact requested configuration unverified |
| [Interhost Linux VPS](https://interhost.co.il/server-product/linux-vps/) | Retrieved Israeli preset prices/specs; custom calculator not quoted |
| [JetServer calculator](https://jetserver.co.il/cloud-pricing) | Dynamic page did not expose a reliable matching total; quote required |

No paid server, browser session, invitation, infrastructure change or external communication was created during this research. No benchmark, restore, microphone capture or end-user compatibility test was performed. Public evidence supports a feasible proposal; the roadmap explicitly identifies what implementation must prove.
