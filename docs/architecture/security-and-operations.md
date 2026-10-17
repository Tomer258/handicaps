# Security, deployment and recovery

This is a design for one controlled private installation. It does not claim high availability or E2EE. Authentication and media admission must pass adversarial tests before inviting the community.

## 1. Browser authentication

Use ASP.NET Core Identity for accounts/password hashing and cookie authentication for the same-origin Angular/API/SignalR application. The protected authentication ticket contains an opaque session ID and minimal identity; PostgreSQL `UserSession` is the authoritative revocation and expiry record. Validate it on every authenticated HTTP request at this scale. Persist Data Protection keys across deployments and encrypt/protect their storage and backups. [ASP.NET cookie behavior and principal validation](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/cookie?view=aspnetcore-10.0).

Cookie attributes: Secure, HttpOnly, host-only, Path=/, `__Host-` prefix, SameSite=Lax. Do not set a parent-domain cookie. Use antiforgery tokens for unsafe operations including login/logout and invitation redemption. The XSRF token can be available to Angular; the authentication cookie cannot. Check Origin/Referer where applicable as additional protection, and reject cross-origin credentialed requests. A cross-site invitation navigation can open a landing page, but redemption remains an explicit protected POST.

Default persistent session: seven-day inactivity limit and thirty-day absolute maximum; a non-remembered login uses a session cookie with a shorter server-side limit. Renew only while the session is active and under the absolute cap. Login regenerates the session identifier. Password reset/disable revokes sessions and voice leases. Rate-limit authentication by both account and IP, use increasing delays/temporary lockout, and avoid login-name enumeration. Administrator 2FA and recovery codes are strongly recommended before public exposure.

JWT is appropriate for the short-lived LiveKit credential, not necessary for the first-party browser's application authentication. A persistent browser JWT would still require revocation/refresh handling and expose a bearer token to JavaScript if stored there. Add OAuth/OIDC later if an actual external-client/SSO requirement appears.

## 2. SignalR authorization and session revocation

Authenticate the hub handshake using the application cookie. Allow only the expected browser Origin on public WebSocket endpoints; CORS alone is not WebSocket protection. Apply payload-size, connection and invocation rate limits. Hub filters validate session and resource policy per invocation. Close connections at authentication expiration, but do not confuse this with immediate revocation. [SignalR authentication behavior](https://learn.microsoft.com/en-us/aspnet/core/signalr/authn-and-authz?view=aspnetcore-10.0).

Keep an in-process connection registry keyed by session and user. On revocation, atomically mark the session revoked, remove channel subscriptions, suppress future delivery, signal connection shutdown and disconnect relevant media participants. Do not rely only on a cooperative browser receiving a SessionRevoked event. The server transport/connection-abort mechanism for already established hubs must be verified with the pinned ASP.NET version; authorization filters and recipient filtering remain required even before a socket closes. Periodic reconciliation sweeps stale connections and expired sessions.

SignalR groups are not durable, not a user-count database, and not an authorization boundary. Rebuild groups after reconnect and filter sensitive outgoing events against current policy. [Groups documentation](https://learn.microsoft.com/en-us/aspnet/core/signalr/groups?view=aspnetcore-10.0).

## 3. LiveKit tokens and the self-hosted revocation gap

Documented fact: LiveKit access tokens scope room/identity/grants. Initial expiration does not by itself eject an established participant; the server also refreshes connected clients' reconnect credentials. The current docs distinguish Cloud token revocation from self-hosted deployments, where removing a participant does not invalidate its existing token. A sixty-second initially minted token is therefore not a complete revocation design. [Token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/).

**Proposed solution:** add a small admission endpoint in the Media module and make every external LiveKit signaling connection pass through it at Caddy before reaching LiveKit. This is our integration, not an existing LiveKit webhook veto. Caddy supports an HTTP forward-auth check; its configuration must be tested with the selected signaling routes. [Caddy forward authentication](https://caddyserver.com/docs/caddyfile/directives/forward_auth).

The admission check verifies the presented LiveKit JWT's signature, issuer, expiry and grants, then resolves its immutable voice-session identity to PostgreSQL. Require active account, session and lease; correct room/generation; current membership; and no token grants broader than current permission. A valid refreshed JWT is still denied when its session/lease is revoked. Browser origin checks apply in addition to credential checks. Server-worker identities use a separate internally authenticated path and scoped policy.

Enumerate every client signaling and validation URL from the pinned server/SDK (including the `/rtc` WebSocket and any validation/reconnect routes). Protect them all. Reject public admin/Twirp paths; the .NET adapter calls RoomService over the internal network only. Bind backend LiveKit HTTP to loopback/private networking so the gate cannot be bypassed through port 7880, another public hostname, IPv6 or an alternate listener. Strip externally supplied trusted-forwarding headers; never log JWT-bearing query strings.

This admission check is once per signaling connection/reconnection, not per audio packet. Existing live participants are removed or have permissions updated through RoomService. A periodic reconciler compares active leases, sessions, permissions and LiveKit membership; verified webhooks improve responsiveness but are not the only enforcement path. Source restrictions cannot prove media provenance: a hostile member can label arbitrary audio as microphone. Server mute/removal addresses that abuse; official soundboard controls remain independently enforced.

**Mandatory security gate:** obtain an initial and server-refreshed token; revoke the session; replay both on fresh connections, resume attempts and all exposed endpoints. Attempt direct port/IPv6 bypass and stale broader grants. Access must be denied. If the gate cannot safely cover the pinned stack, do not claim immediate self-hosted revocation: revise the design to a proven authorization gateway, use a media service with verified revocation, or explicitly accept a bounded weaker policy after review. Do not silently ship TTL-only authorization.

Runtime outage boundary: new joins/rejoins fail closed if the application/database cannot validate them. Existing media can continue through a short API outage. A host-local watchdog closes public signaling/media access if authorization reconciliation has been unhealthy for 60 seconds, forcing a recoverable room outage instead of indefinite authorization drift. A single host cannot offer stronger availability than its components; alert when reconciliation or the watchdog fails.

## 4. Web and file security

Serve all public pages and APIs with HTTPS and WSS. Enable HSTS after domain/TLS operation is proven. Use CSP with narrowly allowed script/connect/media sources, frame-ancestors protection, no mixed content and `nosniff`. Avoid broad inline-script exceptions. Render message text through Angular escaping; if Markdown is introduced, use a reviewed sanitizer and reject embedded raw HTML. Avoid `bypassSecurityTrust...` on user content. Parameterize database access and validate DTOs at the boundary.

File checks include authentication, authorization, quota, allowed purpose/type, detected MIME/magic, size and decode limits, randomized internal names, traversal/symlink protection and storage outside the public webroot. Never execute uploaded HTML, SVG, scripts or archives inline. Images are decoded/re-encoded with pixel limits; documents and arbitrary permitted attachments download with attachment disposition. Add a malware scanning stage for general attachment sharing before production; it may be a scheduled/on-demand scanner rather than a large always-running service. Until that stage is available, restrict uploads to the validated safe allowlist. [Upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

The sound validator is isolated from the media worker. It has no network, DB password, LiveKit key, or Docker socket, and cannot overwrite ready files. Bounded parsing and normalized output reduce risk but are not a claim of perfect malware detection. Pin/patch FFmpeg and the base image. Never let untrusted filenames become shell commands, codecs, filters, protocol URLs or command-line options.

Authorized downloads recheck current parent-channel/library access. Same-origin cookie-authenticated GETs support range requests and private cache headers; do not expose a guessable public directory. Short-lived download tokens are optional later, with revocation tradeoffs documented. Avoid caching sensitive media in a service worker by default. Signed webhooks use raw body validation, expected issuer, timestamp/dedup and size limits.

## 5. Encryption and secrets

HTTPS encrypts application traffic. WebRTC uses DTLS-SRTP between each client/publisher and the SFU. The SFU is a trusted media intermediary; this is **not end-to-end encryption between users**. Files, messages and backups require their own storage protection. LiveKit offers application E2EE capabilities, but this proposal does not enable or distribute room keys. Adding E2EE would require a key-management design and a decision about the trusted soundboard publisher. [LiveKit encryption](https://docs.livekit.io/transport/encryption/).

Use root-owned mounted secret files or Compose secrets with restrictive permissions; plain Compose secrets are not magically encrypted on disk. Separate API/database, LiveKit signing, worker-service and backup credentials. Keep production secrets out of source, images, logs and AI prompts. Give the publisher short room-scoped tokens rather than a permanent administration key. Rotate keys through a tested overlapping rollout; revocation/audit is independent of rotating every key for one user.

## 6. Container and networking plan

| Container/process | Responsibility | Network / mounts |
|---|---|---|
| Caddy with LiveKit Layer 4 support | Static Angular build, HTTPS/WSS, signaling admission, TURN/TLS routing | Public 80/443; persistent cert state; read-only SPA files |
| API | ASP.NET monolith and in-process dispatch/reconciliation jobs | Private 8080; DB and internal media access; uploads/ready file mounts; protected Data Protection key volume |
| PostgreSQL | Durable application state | Private 5432 only; persistent data volume |
| LiveKit | SFU, signaling, embedded TURN | Host networking recommended for media performance; private HTTP/admin; explicit public ICE/TURN ports |
| Sound publisher | PCM-to-RTC audio, no user-media subscription | Private authenticated control; RTC connection; ready sounds read-only |
| Asset validator | Bounded FFmpeg/image validation | `network_mode: none`; quarantine/spool input and isolated output mounts; no secrets |
| Backup/maintenance job | Dump/export, encrypted off-host upload, cleanup | Scheduled short-lived process; limited credentials and bandwidth |

No separate Angular Node server, standalone coturn, Redis, Kafka, Kubernetes, LiveKit Ingress or Egress is required. LiveKit documents single-node operation without Redis; add Redis only with distributed LiveKit or an independently justified application need. The official deployment template may include Redis—remove it deliberately for this design and test single-node behavior. [SFU internals](https://docs.livekit.io/reference/internals/livekit-sfu/).

### Public/private ports

| Port | Exposure | Purpose |
|---|---|---|
| TCP 80 | Public | ACME issuance and HTTPS redirect |
| TCP 443 | Public | HTTPS/WSS and TURN/TLS, routed by hostname/SNI |
| UDP 7882 | Public | LiveKit single-port ICE/UDP multiplexing |
| TCP 7881 | Public | Direct ICE/TCP fallback |
| UDP 3478 | Public | Embedded TURN/UDP/STUN |
| TCP 7880 | Loopback/private only | LiveKit signaling backend and RoomService |
| Internal TURN listener, normally 5349 in the generated topology | Private only | Layer 4 proxy backend; TLS configuration must match generated template |
| TCP 8080 / 5432 | Private only | API / PostgreSQL |
| Metrics port, e.g. 6789 | Loopback/private only | LiveKit metrics, never public administration |
| TCP 22 | Administrator IP/VPN only | Key-only SSH; no password/root login |

Use the documented UDP multiplex port instead of also opening the default 50000–60000 range. Advertise the actual public address; test IPv4/IPv6 and NAT. Firewall both the host and provider network; Docker published ports can bypass naïve UFW expectations, so verify externally. The worker's local media traffic is internal traffic, not public egress, unless a networking error hairpins it through an external route. [LiveKit ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/).

### Resolving TCP 443 correctly

`app.example` serves Angular/API/SignalR, `rtc.example` serves gated LiveKit signaling, and `turn.example` identifies TURN/TLS. All can resolve to the same VPS. Stock HTTP reverse proxying cannot proxy TURN, and two processes cannot both bind the same IP/TCP port. Use the official LiveKit Caddy deployment pattern with its Layer 4 module for SNI routing and automatic certificates; the HTTP leg retains normal Caddy routes and admission middleware. The TURN leg goes directly to the embedded TURN listener, never through HTTP authentication.

Copy the pinned generator's TURN TLS-termination model intact, including any external-TLS setting; do not mix TLS passthrough with a plaintext backend. Add the app host and gated RTC route and test forced TURN/TLS from a client with UDP and direct ICE/TCP blocked. If maintaining that Caddy module is unacceptable, use a second public IP or a small separate TURN host on TCP 443; it adds cost. Port 5349 alone is not an equivalent fallback for networks allowing only TCP 443. [Official VM deployment](https://docs.livekit.io/transport/self-hosting/vm/), [deployment source](https://github.com/livekit/deploy).

## 7. Volumes, releases and observability

Persistent data: PostgreSQL; ready attachments/avatars/sounds; validation spool/quarantine with cleanup; ASP.NET Data Protection keys; Caddy certificate state. LiveKit rooms and presence are ephemeral and reconstructable. Keep asset filenames immutable and store schema/manifest versions. Apply container resource budgets, read-only root filesystems where possible, unprivileged users, dropped capabilities, log rotation and health checks. Do not run image builds or load generators on the production VPS during busy voice use.

CI builds versioned images, tests them, scans dependencies and emits a release manifest with digests. Deployment runs compatible database migrations as a one-off job, backs up first, then replaces the API/worker/SPA. An app deployment should preserve LiveKit when no media change is needed. A LiveKit upgrade is a scheduled room interruption; a single instance cannot promise rolling zero-downtime media upgrades. Rollback requires schema-compatible images; destructive migrations need a separate reviewed release.

Observe API error rate/latency, PostgreSQL size/locks, dispatch lag, active human count, media bytes/packets, RTT/jitter/loss, retransmissions, bitrate/FPS, CPU steal, host RAM/swap, disk free, worker latency, failed uploads, certificate expiry and last successful off-host backup. Use structured local logs and a minimal metrics collection/alert path first; a full Grafana/Prometheus stack is optional. Browser statistics are sampled and aggregated, never full media content. Alert at 70% traffic allowance, 75% sustained CPU, 80% disk, overdue backups and persistent authorization-reconciliation failure.

## 8. Failure behavior

| Failure | Client behavior | Server responsibility |
|---|---|---|
| Refresh / tab closes | Voice ends; reopen shows Rejoin; screen needs fresh picker | Expire/reconcile old lease; no orphan publisher |
| Short network loss | Independent SignalR/LiveKit backoff with jitter; preserve drafts | Dedup writes, allow authorized reconnect, expire stale presence |
| New full connection | Request fresh media authorization if needed | Gate refreshed/old credentials against active lease |
| Mic removed | Show device lost, stop audio; user selects replacement | Reconcile publication state |
| Screen permission revoked | Stop screen video and audio, stay in voice | Release reservation via webhook/reconciliation |
| API restart | Existing media may continue briefly; sound starts/text unavailable | Rebuild connection state; resume outbox; reconcile leases before new grants |
| PostgreSQL unavailable | No new sends, logins, play starts or media joins | Fail closed for authorization; existing media bounded by watchdog policy |
| SignalR unavailable only | Use REST history/status recovery; voice continues | Outbox remains durable; reconnect rebuilds subscriptions |
| LiveKit restart | Show reconnecting; republish permitted live tracks or request new consent | Recreate rooms/worker, clear obsolete track IDs/generations |
| Publisher crash | Voice/screens continue; soundboard unavailable | Fail uncertain sounds; never replay them; restart worker epoch |
| Validator crash | Upload remains pending/failed; existing sounds work | Retry bounded idempotent validation jobs, clean partial output |
| Caddy failure | WebSocket interruption; direct media may survive temporarily | Restart edge; preserve cert state; gate all new joins |
| VPS loss | All functions unavailable | Restore onto new host using off-host backup |

## 9. Backups and restore

Target RPO ≤24 hours for messages/files and RTO ≤2 hours after replacement infrastructure is available; these are operational goals that require a drill. Provider snapshots alone are not independent backups and are not necessarily database-consistent.

Nightly, briefly pause asset finalization/deletion, create a consistent PostgreSQL dump plus ready-asset manifest, snapshot/copy the immutable referenced files, then resume. Include encrypted key material, configuration and release/schema manifest in protected backups with keys held separately. Send an encrypted backup to another failure domain/account, retain seven daily plus four weekly copies and keep growth/quota alarms. Do not keep multiple full copies on the small production disk.

Monthly restore rehearsal: create a clean host, restore database and exact referenced assets, restore or deliberately replace keys/certificates, check checksums, expire all sessions/voice leases by policy, verify login/history/download/soundboard, and record restore duration. Test deleted/missing-asset behavior and rollback compatibility. Recovery is not verified until an independent client can use the restored service.
