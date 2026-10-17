# Implementation roadmap, acceptance tests and risks

**Implementation begins only after architecture approval.** Phase 0 is deliberately first because the browser audio path and media authorization can change scope. No experiments below have been executed as part of this documentation task.

## 1. Incremental roadmap

### Phase 0 — Feasibility and integration gates

**Dependencies:** approval of the proposal, two real Windows PCs, an eligible trial host, a domain and access to current browser/SDK versions.

**Deliverables:** disposable minimal Angular/media harness, pinned compatibility matrix, recorded statistics and a short pass/fail report. No full social UI yet. The harness must use the same planned capture and audio output path as production.

**Acceptance:** two PCs exchange actual microphone, game audio and server-published soundboard audio simultaneously; remote speech is not fed back through system capture. Both Chrome and Edge pass the target path. A custom track is correctly attributed and independently muted. Two actor tracks work and fifteen allocated/idle actor tracks do not leak bandwidth. The self-hosted admission gate rejects initial and refreshed revoked tokens. Forced TURN/TLS succeeds on TCP 443 with UDP and direct ICE/TCP blocked.

**Tests:** real-game/window/tab/monitor matrix; microphone denied; autoplay blocked; source stopped; publisher crash; per-actor mute; token replay/bypass; low-bandwidth/loss tests; Caddy routing and certificates.

**Blockers and decision:** if safe system/window audio fails, certify a narrower working browser/Windows path, offer explicit tab/video-only fallback, or propose a native companion. If strict media revocation fails, revise the authorization integration/provider. If server-published tracks cannot satisfy controls, revise the soundboard ADR. Do not proceed to weeks of UI work assuming these failures will disappear.

### Phase 1 — Foundation, identity and reproducible development

**Dependencies:** Phase 0 choices recorded; version matrix and repository conventions agreed.

**Deliverables:** Angular standalone shell/routes, ASP.NET module skeleton, PostgreSQL migrations, invitations/login/sessions, profile/preferences basics, Compose development environment and CI. Establish private storage and the API/OpenAPI boundary.

**Acceptance:** fresh checkout can run with documented commands; two users register with valid invitations; expired/reused invites fail; login survives API restart with persisted keys; session revoke blocks HTTP and active hub activity. No production secret is required for tests.

**Tests:** concurrent invitation redemption, normalized-login uniqueness, CSRF/Origin rejection, session expiry, permission evaluator truth table, migrations against the selected PostgreSQL version, module dependency rules.

**Blockers:** mismatched Node/TypeScript/Angular dependencies, Data Protection key persistence, same-origin development routing, unsafe cookie defaults.

### Phase 2 — Text channels, history, files and presence

**Dependencies:** identity, workspace membership and policy services.

**Deliverables:** server/channel views, text sends/edits/deletes/replies/reactions, validated attachments, mentions/unreads, event outbox/cursors, SignalR and presence. Put basic roles/channel overrides in place now rather than retrofitting them after media.

**Acceptance:** a committed send appears once after retry; concurrent sends order consistently; edits/deletes/reactions converge after disconnect; denied channels are absent from history, notifications and file delivery. Presence expires after missed heartbeats and one closed tab does not mark another connected tab offline.

**Tests:** send/commit/crash-before-broadcast, duplicate request with altered body, join/snapshot race, expired delta cursor reset, channel policy change while connected, pagination with deletes, stale disconnect epochs, unsafe image/document upload and orphan cleanup.

**Blockers:** using timestamps as total order, missing outbox, client-only ACLs, read positions advanced by delivery rather than reading.

### Phase 3 — Voice and media authorization

**Dependencies:** certified Phase 0 transport/gate, identity and policies.

**Deliverables:** deployed LiveKit, voice join/switch/leave, global media service, microphone device switching, mute/deafen, participant volume, speaking indicators, authorization reconciliation and reconnect UI.

**Acceptance:** fifteen humans join one room; navigation among text routes preserves voice; one voice lease/user is enforced; mic loss produces a clear state; revoked users cannot listen/publish/rejoin; sound worker slot is separate from the fifteen-human limit.

**Tests:** permission change mid-call, two tabs racing join, room switch failures, network loss/full reconnect, fresh and refreshed JWT replay, server restart, expired session, output-device fallback, forced TURN.

**Blockers:** unprotected signaling route, default metadata/data grants, root services recreated by lazy routes, lease state based solely on a client heartbeat.

### Phase 4 — Screen sharing and quality control

**Dependencies:** voice lifecycle and browser audio feasibility.

**Deliverables:** full-screen/window/tab capture, optional separately labeled screen audio, one/two/four-stream layouts, focused fullscreen viewer, presets, stats-driven fallback and explicit subscriptions.

**Acceptance:** 1080p/60 can be demonstrated on certified capable devices and 720p/30 fallback is usable. Capture UI reports actual returned audio. Starting/stopping share preserves voice/camera. A source ending cleans both screen tracks. Scenario A and B meet the agreed latency/resource targets.

**Tests:** screen stopped from browser chrome; permission decline; wrong/no audio source; DRM/black-frame handling; other speakers during game capture; local soundboard recapture; high packet loss; bandwidth drop; background tab and minimized game behavior.

**Blockers:** promising every game 60 FPS, using speech processing on game audio, sending all high streams to every viewer, or considering headphones a fix for digital loopback.

### Phase 5 — Full soundboard MVP

**Dependencies:** proven publisher path, private storage/validator, voice leases and shared permission service.

**Deliverables:** library/grid/search/favorites, upload/normalized preview, ownership/rename/delete, permission controls, authoritative play/stop, separate actor tracks, volume/mute, optional ducking, focused shortcuts and accessibility.

**Acceptance:** an authorized user with microphone permission denied can play an effect that another computer hears through LiveKit. Voice and game audio remain separate. Per-actor sound mute affects only that actor's effects. Two concurrent starts succeed and a third gets a clear busy response. Stop works remotely, duplicate requests do not replay, and expired/offline requests do not fire later.

**Tests:** the complete soundboard matrix below, malformed-file corpus, quota/rate races, worker restart with uncertain acknowledgement, deleted asset in active playback, authorization revocation, remote energy/spectrum assertions, screen and soundboard volume isolation.

**Blockers:** single mixed soundboard track, unbounded server audio queue, replaying commands after worker restart, UI saying Playing on HTTP acceptance rather than actual start.

### Phase 6 — Webcam and user experience completion

**Dependencies:** stable media ownership and subscription model.

**Deliverables:** camera controls/layouts, preference synchronization, in-app and opt-in browser notifications, DND, responsive and keyboard UX, accessibility review and a useful connection diagnostic panel.

**Acceptance:** camera and screen coexist; hidden video subscriptions reduce load; devices and volume preferences persist safely; DND suppresses optional notifications; UI is usable by keyboard and at narrow widths. Screen publishing on mobile and closed-tab push remain explicitly outside the release guarantee.

**Tests:** six cameras plus streams, device selection before/after permissions, accessibility scan and manual keyboard/screen-reader pass, Hebrew/bidirectional messages, long/empty names, revoked notification permission and route transitions.

**Blockers:** ten high-resolution decoders overloading client hardware, visual-only mute status, browser notification APIs assumed to work without permission.

### Phase 7 — Production hardening and first release

**Dependencies:** all functional phases and an agreed limited release scope.

**Deliverables:** real A/B/C load results, four-hour soak, security review, independent backup/restore, deployment/rollback runbooks, dashboards/alerts, pinned images and source versions, dependency/license review and selected host quote.

**Acceptance:** zero unresolved critical access-control findings; 15-human load meets the chosen limits; resource/traffic alarms work; restore achieves the declared RPO/RTO in a drill; secrets and logs are reviewed; game audio and soundboard checks pass on both supported browsers. If C fails, document and enforce the lower limit or resize before advertising it.

**Tests:** realistic media load, external port scan, forced TURN, abuse/rate tests, DB outage, API/worker/SFU restarts, interrupted upload, disk-full simulation in test environment, expired certificate alert, restore to a clean host and rollback with compatible schema.

**Blockers:** simulated-only media evidence, missing off-host backup, shared-VPS throttling, unverified regional transfer terms, untested authorization gateway.

Planning allowance: approximately 40–70 focused developer-days for a tested first release, with a broad uncertainty range. AI assistants can accelerate repetitive work but do not replace OS/device validation or operational learning. Treat this as sequencing guidance, not a delivery commitment.

## 2. Test layers

| Layer | Tools / scope | What it proves |
|---|---|---|
| Angular unit/component | Angular-supported runner (Vitest when compatible), fake SDK adapters | Stores, forms, volume calculation, lifecycle and keyboard behavior |
| .NET unit | xUnit or one consistent equivalent | Policy resolution, limits, state transitions and validation |
| Database integration | Real PostgreSQL via Testcontainers or CI service | Unique/FK constraints, transaction locking, cursor ordering and rollback |
| API integration | ASP.NET test host plus real DB | Auth/CSRF, idempotency, ownership, range/download and error contracts |
| SignalR integration | Real server with multiple clients | Unauthorized groups, reconnect/delta repair, revocation and ordering |
| LiveKit integration | Pinned real server and RTC clients | Scoped grants, admission, real publication/subscription and cleanup |
| Browser E2E | Playwright, real Chrome and Edge channels where possible | UI flows, multiple isolated contexts, autoplay/reconnect/routing behavior |
| Device certification | Real Windows PCs, speakers/headsets, real game | OS picker, audio isolation, drivers, acoustic/digital feedback and actual FPS |
| Load/security/operations | External load generators, network impairment, restore host | Sustained behavior and recovery beyond a single demo |

Keep tests aligned with risks. Mocking LiveKit is valuable for Angular unit tests but not proof of media transmission. Do not add broad snapshot suites that merely mirror markup or implementation details.

## 3. Soundboard acceptance matrix

| Test | Setup / expected result |
|---|---|
| S01 — remote transmission | A invokes a known sound; B on a different browser client receives decoded audio with expected spectral/energy content and a LiveKit track SID |
| S02 — no microphone | A denies microphone access and remains listen-only for mic; sound plays for A and B using authorized soundboard permission |
| S03 — mic plus sound | A speaks continuously while playing; B receives both distinguishable tracks, no forced mic mute |
| S04 — screen plus sound | A shares a game tone and invokes an effect; B receives both without double-playing/feedback |
| S05 — local volumes | B soundboard at zero, C at 50%; B still hears voice/screen; C hears effect; neither changes global publication |
| S06 — actor mute | B mutes A's effects; another actor's overlapping effect is audible while A's is not |
| S07 — simultaneous requests | Concurrent transactions admit at most two effects installation-wide and one per actor; rejected requests do not reserve forever |
| S08 — stop races | Stop before start, during play and after completion is idempotent; no delayed restart; measured stop latency meets target |
| S09 — replay/dedup | Repeated request ID returns original state; changed payload conflicts; expired request after reconnect never plays |
| S10 — interruption | Publisher/network restarts mid-effect; no replay; voice remains operational when only publisher fails |
| S11 — permissions | Forbidden play/upload/manage/stop fails at API; removing channel access stops playback and prevents later requests |
| S12 — autoplay | Block playback before join; show Enable Audio; starting sound remotely does not bypass the browser restriction |
| S13 — cleanup | Repeated room joins/leaves and dialog previews leave no extra tracks, audio nodes, media elements or workers |
| S14 — audio quality | Quiet, clipped, very short, stereo and full-scale effects normalize safely; two concurrent effects do not clip final output |
| S15 — attribution | Spoofed client names/track metadata cannot masquerade as approved publisher soundboard tracks |
| S16 — all listeners | Fifteen authorized clients receive the stream; local deafening/mutes/autoplay limitations are represented honestly |

Automated media tests can publish a deterministic PCM fixture through the actual worker/SFU and inspect B's received track with an analyser or recording available only in the test harness. Assert decoded sample content plus transport state, not only `play()` calls or increasing packet counters. Separate browser contexts test routing; separate physical PCs are still required for capture/driver/feedback certification. Never record real users' calls for routine testing.

## 4. Performance acceptance goals

| Metric | Initial goal on certified devices/host |
|---|---|
| Send commit API | p95 <250 ms at 20 mutations/s excluding user ISP RTT where measured server-side |
| Committed message visibility | p95 <500 ms end-to-end on normal connections |
| Voice mouth-to-ear | p95 <200 ms on tested normal routes; investigate TURN/TCP separately |
| Screen glass-to-glass | p95 <400 ms for certified game preset; quality/FPS also reported |
| Sound warm/cold onset | p95 ≤500 ms / ≤1 second |
| Stop-to-silence | p95 ≤400 ms |
| Recovery after network returns | p95 <10 seconds for authorized reconnect, excluding fresh user capture consent |
| CPU / memory | <70–75% sustained CPU, no material CPU steal, ≥1.5 GiB headroom |
| Data safety | No acknowledged message loss after crash; duplicates reconcile; restore passes |

Targets are acceptance objectives, not measured results or universal guarantees. Report raw distributions and failures, not only averages. Voice quality takes precedence over holding 1080p/60 during congestion.

## 5. Principal risk register

| Risk | Impact | Mitigation / release gate |
|---|---|---|
| Browser game audio unavailable on selected OS | Core requirement fails | Phase 0 matrix; certify working combinations or approve fallback/native scope |
| System capture returns call audio | Echo and privacy leak | Own-audio exclusion/isolation test with distinct remote audio; headphones alone insufficient |
| Stale self-hosted media token | Unauthorized rejoin/listening | Gate all signaling + active removal + token replay/bypass suite |
| Server sound mix loses actor controls | Mandatory mute/volume behavior fails | Separate actor tracks; S05/S06 before UI completion |
| VPS port/traffic limit | Stuttering or unexpected cost | Explicit formulas, measured throughput, alerts, regional quote and subscriptions |
| Shared CPU contention | Latency spikes | Measure steal during evening load; resize/move if persistent |
| Unsafe audio/image parsing | Host compromise or resource exhaustion | Restricted validator, patching, limits, malformed-input tests |
| SignalR assumed durable | Lost/duplicate UI state | Transactional event log, cursors, versioned idempotency tests |
| API outage while media continues | Revocation drift | Fail-closed new admission, reconciliation and bounded watchdog policy |
| Single VPS loss | Entire service down/data loss | Independent encrypted backups and restore rehearsal |
| Client decode/encode overload | Poor quality despite good server | Device measurements, visible subscriptions, lower layers/FPS |
| Scope and agent drift | Unmaintainable implementation | Small vertical slices, ADRs, contract changes reviewed, no unrelated refactors |

## 6. Requirement traceability

| Brief requirement group | Specification location | Acceptance owner |
|---|---|---|
| Executive summary, assumptions, feasibility, final recommendation | README and architecture | Architecture approval + Phase 0 |
| Mandatory Angular, state and navigation lifetime | Architecture §§3–5 | Phases 1/3/6 |
| Backend, text transport and durable history | Architecture §§6–7; data model/contracts | Phase 2 |
| Voice, media authorization and lifecycle | Architecture §8; security/operations | Phases 0/3/7 |
| Monitor/window/tab, game/system audio, multiple streams | Browser research; capacity | Phases 0/4/7 |
| Core soundboard and custom uploads | Soundboard; data model/contracts | Phases 0/5 and S01–S16 |
| Schema, indexes, uniqueness, deletion/retention | Data model/contracts | Phases 1/2/5/7 |
| Authentication/security/encryption | Security/operations | Phases 1/3/7 |
| Containers/ports/TLS/backup/recovery | Security/operations; diagram 11 | Phases 0/7 |
| Workloads A/B/C and hosting comparison | Capacity/hosting | Phases 4/7 |
| Eleven architecture views | Diagrams and standalone sources | Documentation validation |
| Thirteen requested ADRs | ADR index | Architecture review, preserved across implementation |
| Roadmap/testing/risks | This document | Each phase gate |
| Repository and AI-assisted workflow | Development workflow | Every implementation change |

MVP is complete only after the soundboard and required supported screen-audio path are included. Reordering phases does not demote either feature to an optional future enhancement.
