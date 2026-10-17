# Architecture specification

**Proposal v1.0 — 17 October 2026.** Read with [browser research](browser-media-research.md), [soundboard design](soundboard.md), [schema and contracts](data-model-and-contracts.md), and [operations](security-and-operations.md). All application behavior below is proposed, not implemented.

## 1. Executive recommendation

Build a private communication application around an Angular SPA, one ASP.NET Core modular monolith, PostgreSQL, and LiveKit. The backend owns membership, authorization, durable messages, invitations, files, and soundboard commands. LiveKit owns real-time media sessions and distribution. A constrained Python RTC worker supplies soundboard media; a restricted validator prepares uploaded assets. Caddy serves the SPA and terminates public TLS, including a documented Layer 4 arrangement for TURN on TCP 443.

The requested product is feasible for fifteen friends. The difficult parts are browser capture behavior, avoiding feedback, recovering authorization across connections, and forwarding enough outbound video traffic. A good-looking chat interface does not prove these features. Complete the early media and security experiments before building the full UI.

Use a single workspace initially, with owner, administrator, moderator, and member roles. Retain workspace IDs in tables and contracts so a second private workspace does not require a schema rewrite. Do not build public discovery, federation, bots, payments, video recording, full-text search infrastructure, or mobile-native clients in the MVP.

## 2. Assumptions and product limits

| Area | Proposed baseline |
|---|---|
| Population | 15 registered humans and up to 15 connected humans across all voice rooms |
| Voice membership | One active voice session per user; text-only tabs and multiple logged-in devices allowed |
| Browser certification | Current stable Chrome and Edge on supported Windows; other desktop browsers get capability-based fallback |
| Media | One microphone, one camera, one screen-video and one screen-audio publication per human |
| Screens | Four simultaneous screen publishers across the installation; normally one high-resolution stream visible per viewer |
| Camera | 720p/30 maximum baseline, lower layers for small tiles; six cameras in capacity scenario C |
| Screen quality | Up to 1080p/60 at a configured 8 Mbps high-layer ceiling; 720p/30 at 2 Mbps fallback |
| Soundboard | Mandatory MVP; five-second effects, two simultaneous effects installation-wide, one per triggering user |
| Availability | Best effort for a friends' community; one VPS is a deliberate single point of failure |
| Recording | None; no LiveKit Egress, video files, STT or LLM services |
| Confidentiality | TLS and WebRTC transport encryption; no application-level E2EE in MVP |
| Authentication | Invite-only local accounts; no paid identity provider or email service required |
| Cost | Aim for a low tens-of-dollars monthly operating budget; no fixed budget was supplied |

The five-second and two-effect limits are starting product choices, adjustable by an administrator after measurements. No promise of 60 FPS applies to every game, display, laptop, or network. Closing the tab ends media; a background tab can still be suspended by the browser or OS. An installed PWA does not grant global hotkeys or unrestricted audio capture.

## 3. Technology choices and version policy

| Layer | Choice | Reason and boundary |
|---|---|---|
| Frontend | Angular 22, TypeScript compatible with its current minor | Required by brief; standalone feature components, typed forms, lazy routes |
| Runtime for builds | Node 24 LTS at a compatible patch; npm lockfile | Build tooling only, not another production web server |
| UI | Angular CDK plus selected Material controls | Dialogs, focus, overlay, accessibility; custom channel/media layout |
| State | Signals in services plus RxJS at async boundaries | Small team and small data set; no NgRx global store initially |
| Backend | ASP.NET Core 10 LTS, EF Core 10 with compatible Npgsql | Strong typed APIs, Identity, SignalR, rate limiting and background jobs |
| Durable database | PostgreSQL 18, current supported patch | Transactions, constraints, ordered messaging and small job/outbox tables |
| Application events | ASP.NET Core SignalR JS client | Presence, message mutations, notifications and playback state |
| Media | Pinned stable LiveKit server and compatible JS SDK | Established SFU, reconnection, subscriptions, TURN and administration |
| Sound publication | Python LiveKit RTC SDK, without Agents/AI framework | Documented raw PCM audio publishing; scoped to approved sound files |
| Asset validation | FFmpeg/ffprobe in a restricted worker | Bounded decode, duration checks and loudness normalization |
| Storage | Private local persistent volumes | Cheap, sufficient for a single replica; repository abstraction enables migration |
| Edge | Caddy with the LiveKit deployment's Layer 4 module | SPA/HTTP/WebSocket TLS and TURN/TLS sharing one public IP |
| Host | Ubuntu 24.04 LTS, Docker Engine and Compose | Mature supported base; no Kubernetes |

Angular's official matrix currently lists version 22 active and a Node 24.15+/TypeScript 6.0 compatibility line. .NET's support page lists .NET 10 as LTS through November 2028. PostgreSQL 18 is supported. Reconfirm the exact minor/patch combination and image digests at Phase 0; never use floating `latest` production images. [Angular releases](https://angular.dev/reference/releases), [compatibility](https://angular.dev/reference/versions), [.NET policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core), [PostgreSQL policy](https://www.postgresql.org/support/versioning/).

ASP.NET Core remains the right backend. NestJS would reduce the number of languages around the web SDK, but brings little value against the preferred .NET stack. Mediasoup is a capable lower-level alternative; its additional room/signaling orchestration is unnecessary for a single developer. Reusing an existing Matrix/Element or conferencing product would be faster if custom development ceased to be a goal, but would not deliver this Angular application architecture without substantial adaptation. These are alternatives, not additional components.

## 4. System boundaries

REST handles request validation, durable commands, history queries, file transfer, and token issuance. SignalR handles transient updates after database commit and small ephemeral events. LiveKit's signaling and WebRTC transports handle voice, camera, screen, and soundboard media. Never put continuous audio/video into SignalR messages, PostgreSQL, or base64 HTTP polling.

The monolith uses one process and one database. Modules communicate through typed in-process services; durable cross-boundary notifications use one PostgreSQL event/outbox mechanism. Do not introduce a message broker, service discovery, Redis cache, CQRS framework, or generic repository layer around EF Core merely to match an architectural style.

The two media workers are operational isolation boundaries. They do not own users, permissions, or independent databases. The API makes all product decisions. The publisher uses internal authenticated calls to receive commands; the validator consumes file jobs from a private filesystem spool and has no network or media credentials.

## 5. Angular architecture

### Feature structure

| Area | Owns | Must not own |
|---|---|---|
| `core/auth` | Session facade, current user, antiforgery bootstrap, route access hints | Final authorization decisions |
| `core/api` | Generated typed HTTP client, ProblemDetails mapping, request IDs | Domain state or media objects |
| `core/realtime` | Singleton SignalR connection, reconnect coordinator, event decoding | Microphone or video delivery |
| `features/workspaces` | Workspace/channel navigation and membership views | Global media lifetime |
| `features/messages` | Message store, composer, virtualized history, reactions/read positions | Unbounded whole-history memory |
| `core/media` | Root-provided `MediaSessionService`, LiveKit adapter, capture/device manager | Chat page component lifecycle |
| `core/audio` | Track registry, output device, class/user gains and deafen | Permission grants or server sound selection |
| `features/voice` | Persistent dock, participant grid, connection/recovery UI | Creating a new Room on every route |
| `features/screen-share` | Capture dialog, viewer tiles and quality controls | Capturing without a direct user gesture |
| `features/soundboard` | Sound catalog, favorites, upload/preview dialogs, playback commands | Pretending local preview is a room broadcast |
| `features/settings` | Device, volume, notifications and profile preferences | Storing tokens in localStorage |
| `features/admin` | Invitations, roles, quotas, moderation and audit views | Bypassing normal API policies |
| `shared/ui` | Presentational controls, empty/loading/error states | Feature stores and network calls |

`AppShell` owns a persistent `VoiceDock` and `MediaPlaybackHost` beside the router outlet. Only route content is destroyed on text-channel navigation. `MediaSessionService` is `providedIn: root`; feature-route providers must not shadow it. It owns one LiveKit `Room`, track disposal, listeners, and the connection state machine. A component unmount detaches its video element only; it does not leave voice. Logout and an explicit Leave call perform centralized teardown.

Keep SDK objects, MediaStreams, AudioNodes, and AbortControllers private to adapters. Expose immutable view models as readonly Signals. Use computed Signals for participants, filtered sounds, effective volume, and unread counts. Use RxJS for reconnect backoff, cancellation, event batching, typing debouncing and request sequencing; convert at well-defined boundaries using Angular's RxJS interop. Avoid parallel Signal and Subject copies of the same state. Clean subscriptions with `takeUntilDestroyed` or equivalent service-lifetime cleanup.

Use standalone components, lazy feature routes, typed reactive forms and strict templates. Start with Angular's supported zoneless setup and OnPush-compatible component design. SDK callbacks update Signals; batch high-frequency speaking/quality stats to roughly 5–10 UI updates/second. Do not trigger a full message-list render for each audio sample. Signals integrate with Angular change detection, but media object mutation itself is not a reactive update. [Signals](https://angular.dev/guide/signals), [zoneless guidance](https://angular.dev/guide/zoneless).

HTTP interceptors attach the same-origin XSRF header, request ID, and safe error mapping. Retry idempotent GETs with backoff; retry a send/upload command only with its original idempotency key. A 401 pauses activity and exposes login recovery; it must not silently loop token issuance. Route guards improve navigation only; the backend still enforces access.

Persist display preferences and volume choices locally and to `UserSettings`. Store no access tokens, password data or audio samples in localStorage. Keep media tokens in memory. On refresh, restore navigation/preferences and show Rejoin; do not automatically activate the microphone or recreate screen capture. A BroadcastChannel warns about a second active tab, while backend voice leases enforce the rule independently of that warning.

Error handling is explicit: the global Angular ErrorHandler reports unexpected errors; each feature shows recoverable request failures. There is no React-style error-boundary API assumed here. SignalR and LiveKit each have their own status and retry state. A failed preview never tears down the voice session.

### Accessibility and interaction

Use semantic buttons, visible focus, sufficient contrast, named mute/deafen state, keyboard-accessible menus, and a restrained live region for connection failures and messages. The sound grid uses a predictable roving tab stop, arrows, Enter/Space to play, Escape to close, and accessible name/duration/favorite state. Search and filters stay ordinary labeled controls. Upload validation errors are linked to fields. Do not autoplay preview sounds on hover. Respect reduced motion. Store text direction independently so Hebrew content renders correctly; use logical CSS properties.

Responsive desktop layout has channel navigation, message pane, optional stream grid and soundboard overlay. Narrow layouts collapse navigation and keep the voice dock reachable. CDK virtual scrolling requires stable measurement or a variable-height strategy for images; bound the rendered history and preserve scroll position when older pages arrive.

### Why not NgRx now?

The domain has few simultaneous users and a manageable number of stores. Service-owned Signals make ownership and cleanup visible. Reconsider NgRx if complex cross-feature workflows repeatedly produce inconsistent state, optimistic updates require substantial replay, or multiple frontend teams need strict conventions. Signals do not replace the server's event/reconnection protocol.

## 6. Backend modules

| Module | Responsibilities | Principal collaborators |
|---|---|---|
| Identity | Password verification, invitation redemption, sessions, account disable/recovery | Users, audit |
| Users | Profile/display name/avatar and preferences | Files |
| Workspaces | Workspace/member/role lifecycle | Permissions |
| Channels | Text/voice metadata and channel policy | Permissions, media |
| Permissions | Single effective-policy evaluator; policy version increments | Every command/query path |
| Messaging | Send/edit/delete/reply/reaction, read positions, event cursors | Files, notifications |
| Presence | Per-connection heartbeats and user status aggregation | SignalR, sessions |
| Media coordination | Voice leases, scoped JWTs, admission checks, LiveKit API/webhooks | Permissions, soundboard |
| Soundboard | Library, play authorization, cooldown reservations, jobs and state | Files, media publisher |
| Files | Quarantine, finalized assets, private delivery, quotas and cleanup | Validator |
| Notifications | Mention/unread records and optional browser notifications | Messaging, preferences |
| Audit/operations | Security/admin audit, outbox dispatch, job reconciliation, health | All modules |

Use feature folders and a small number of projects: API/host, domain/application modules, infrastructure and tests. One EF DbContext is acceptable at this size, with schema/table ownership conventions. Module A calls module B's application service for mutations rather than updating its entities directly. Read projections can use joins. EF transactions are explicit around message/event creation and reservation changes; outbound network calls do not occur inside a long database transaction.

ASP.NET integrates with LiveKit through a small typed `HttpClient` adapter for the documented JSON-over-HTTP Twirp RoomService endpoints and standards-based JWT creation. Contract-test grants and response types against the pinned server. Do not assume the browser JS SDK is a .NET server SDK or introduce Node solely to sign tokens. The publisher independently uses the official Python RTC SDK for media. [RoomService protocol](https://docs.livekit.io/reference/other/roomservice-api/).

## 7. Text messaging and durable synchronization

Use REST to send, edit, delete and react. A successful send returns 201 with the committed message, server sequence and request key. The sender inserts a temporary local bubble and reconciles by `clientMessageId`. It must not render a second bubble when SignalR delivers the same message. `accepted` means durable database commit, not that another user has seen or heard anything.

For each mutation, lock the channel's sequence row, enforce permissions, allocate the next event sequence, persist the domain change and immutable event/outbox row, and commit. Creation also allocates a monotonically increasing message sequence. Sequence allocation and commit happen while holding the same per-channel row lock, preventing concurrent sends from making a later sequence visible before an earlier commit. PostgreSQL `bigserial` alone is not a commit-order guarantee. Clients represent 64-bit cursors as decimal strings to avoid JavaScript precision loss.

A single background dispatcher delivers committed events. It marks delivery attempts after broadcasting, so a crash may create duplicates. Each event carries `eventId`, channel, `eventSequence`, type, entity ID, entity version, actor, and server time. The client deduplicates and buffers bounded out-of-order events, applies entity versions, and resynchronizes on gaps. No exactly-once transport claim is made. Different channels have independent order; reactions and message edits use the same channel event stream so they are recoverable.

Initial load: establish the authenticated event connection; subscribe with authorization; buffer arrivals; fetch a consistent authorized snapshot/history page and high-water event cursor; then request events after that cursor and drain the buffer. A subscription acknowledgement returns a cursor boundary, so events committed between steps are recoverable. On reconnect, rebuild authorized subscriptions and request deltas from the last applied cursor. If the cursor is older than the seven-day event retention, the API returns an explicit reset requirement and the client reloads the current state. Catch-up reads include edit/delete/reaction events, not only newly created messages.

Every history request, delta query, attachment download, hub subscription and dispatched sensitive event checks current access. SignalR groups are routing conveniences and do not confer authorization. At fifteen users the dispatcher can filter connection recipients against the current policy version; avoid trusting a stale group after a role change. Permission changes remove subscriptions and invalidate cached channel data. Unread overview exposes only readable channels. [SignalR group limitations](https://learn.microsoft.com/en-us/aspnet/core/signalr/groups?view=aspnetcore-10.0).

History uses keyset pagination (`beforeMessageSequence`, normally 50 items, max 100), not growing SQL offsets. Edits use an expected version/ETag; conflicts return 409/412. Deletes leave tombstones so replies and synchronization remain coherent. Reply targets must be in the same authorized channel. Reactions are unique by message/user/normalized emoji. Validate mentions server-side against visible members; notify each target once per message/version policy. Avoid leaking an inaccessible channel's name in notification text.

Read positions advance monotonically with a maximum acknowledged message sequence only while the channel is visible and the user has actually reached those messages. Do not mark the entire channel read merely because SignalR delivered an event. Offline users fetch unread state and durable history when they return. Persistent receipt-of-delivery rows for every recipient are unnecessary; read positions supply the optional read semantics.

Typing and presence are deliberately ephemeral. Client heartbeat every 25 seconds, expiration after 75 seconds, idle after five minutes without interaction, manual DND override. Presence aggregates all text connections; one closed tab does not mark the user offline. Track epochs so a delayed disconnect cannot remove a new connection. Browser activity provides an approximate idle signal, not an OS-wide activity monitor. Backend restart marks presence unknown until fresh heartbeats arrive.

## 8. Voice/media architecture

Use SFU forwarding. In a 15-way full mesh, each sender could need fourteen outgoing copies; an 8 Mbps video would require about 112 Mbps from that sender before overhead. With an SFU the sender uploads the chosen encoding layers once, and the VPS forwards selected layers. The SFU does not transcode each screen for every viewer. The cost moves primarily to VPS egress and packet forwarding. A server-side video mixer would need much more processing and eliminate independent viewing controls.

LiveKit provides room signaling and media transport separately from SignalR. One application voice channel maps to one opaque LiveKit room name plus generation. A root media service requests a voice lease from REST, joins with a scoped token, publishes selected devices, and subscribes to allowed tracks. The backend creates rooms with 16 participant slots (15 humans plus one soundboard publisher) and enforces the fifteen-human installation limit itself. The bot is never counted as a human in the UI.

The backend signs participant identity from an opaque voice-session ID. Tokens authorize exactly one room and only allowed microphone/camera/screen sources; no room administration, metadata mutation, recording or arbitrary client data publication. Listen-only users receive no publishing permission. Server source grants cannot prove that audio labeled microphone came from a physical microphone; moderation includes server mute and removal. The soundboard worker uses a distinct identity and a publish-only, subscribe-disabled token scoped to its room.

Room membership is reconciled through verified webhooks and periodic RoomService checks. A client claiming to be in a room is not sufficient to play a sound. On channel switch, revoke the old voice lease and remove the old participant before activating the new lease; retry safely by request key. Keep a bounded reconnect grace, cancel obsolete captures and reject stale callbacks by connection generation. The publisher leaves when the last human leaves; otherwise its presence would prevent normal empty-room cleanup.

Microphone is mono Opus, target 32–64 kbps, with browser AEC/noise suppression/AGC where available. The capacity model conservatively uses 64 kbps for all fifteen simultaneous speakers. Device names may only become visible after permission. A disconnect shows a device error and stops transmission; it must not quietly enable another sensitive input. Use explicit user-confirmed switching and verify the selected track.

Mute affects microphone only; screen audio and soundboard remain independently controllable. Deafen disables all received audio and also mutes the microphone, with a documented restore choice. Individual voice volume changes only that person's microphone track. Speaking indicators derive from microphone audio, excluding the publisher's sound tracks. Browser output-device choice is capability-tested; where unsupported, use the OS default and say so. [Output device API](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId).

Use explicit video subscriptions: join voice with audio subscribed and screens/cameras off until selected or visible. Support up to four stream tiles but default to one high-quality focused stream and low-quality thumbnails. Viewers can enter fullscreen and pin a stream. Enable appropriate simulcast and dynacast after measuring client encoding cost. VP8 is a predictable interoperability baseline; benchmark H.264 hardware encode on target Windows machines and use it only when negotiated and tested. VP9/AV1 are optional later optimization, not necessary for MVP.

## 9. Screen and soundboard integration

Capture starts directly inside a user click so transient activation is preserved; do not wait on a slow REST request before invoking the browser picker. Capture may be obtained first, but nothing is published until the channel authorization and publication reservation succeed. If denied, stop every captured track immediately. Browser dialogs remain browser-controlled.

A screen session contains separate screen-video and optional screen-audio tracks. Publish only returned audio, never claim success because `audio: true` was requested. Audio meters and a clear source label distinguish game/window audio from all-system audio. Camera and microphone continue during screen start/stop. A display track's `ended` event unpublishes and stops both parts of the screen session without leaving voice. User gesture is required again after refresh or ended capture.

The detailed [browser matrix](browser-media-research.md) and [soundboard design](soundboard.md) are normative parts of this specification. Soundboard audio reaches the clicker and other listeners through the same SFU path; it is not injected into their microphones and is not transmitted by the clicker's browser. Its playback is independent of microphone permission and can coexist with screen audio.

## 10. Notifications and preferences

In-app unread badges and mention notifications are mandatory. Optional browser notifications require a user gesture and browser permission and respect DND. Notifications while the page is closed require a separate Web Push/service-worker design; they are not promised by a live SignalR connection. Preserve notification preferences server-side and avoid sensitive text on a locked screen by default.

Profiles have unique login identity and non-unique display names, with stable opaque IDs for authorization. Store avatars as validated raster images with dimension/pixel limits and remove metadata. A display-name change does not affect media permissions. Server/channel settings use optimistic concurrency, audit administrator mutations and prohibit deleting the last owner.

## 11. Release criteria and final decision

Proceed with the recommended stack and narrowly scoped workers, subject to the Phase 0 experiments. Do not trade away independent soundboard volume, server-authorized playback, or secure reconnect for a quicker demo. The most likely scaling step is a larger or separate LiveKit VPS; the monolith and PostgreSQL can remain together well beyond fifteen friends.

Four unresolved facts require measurement: exact Windows build capture support, digital feedback exclusion, shared-VPS sustained throughput/CPU, and signaling-admission compatibility with the pinned LiveKit SDK. Their acceptance criteria and fallback actions appear in [roadmap and testing](roadmap-and-testing.md). The system is designed for production use, but production readiness is achieved through those gates and a restore drill, not through this document alone.
