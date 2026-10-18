# Security review (code + configuration)

Review of the code and configuration against `docs/architecture/security-and-operations.md` §1–§5 on 2026-10-18,
commit after `88efece`. It does not replace the adversarial host tests in pre-release-gates.md, which need the public
deployment. Repeat it before inviting people from outside the group, and after any change to auth, files or the edge.

## Checked and holding

| Area | What was checked | Where |
|---|---|---|
| Cookies | `__Host-hangar`, Secure, HttpOnly, SameSite=Lax, host-only, Path=/; antiforgery cookie is Strict + HttpOnly; XSRF request token is readable by Angular | `Program.cs`, `HangarOptions` |
| CSRF | every unsafe `/api/v1` request (including login, register-by-invite, logout) goes through `CsrfFilter`: Origin must be self or allow-listed, then the antiforgery token is validated | `RequestProtection.cs`, `Program.cs` (group filter) |
| Hub | Origin enforced on `/hubs` (CORS does not cover WebSockets); 32 KB message cap; session revalidated on every invocation; per-connection invocation budget | `Program.cs`, `SessionHubFilter` |
| Sessions | the database `UserSession` is checked on every request (`OnValidatePrincipal`); password change revokes the other sessions and notifies their connections and voice | `AuthService`, `SessionRevocationNotifier` |
| Two-step login | TOTP (RFC 6238, ±1 step, replay-proof compare-and-set) or a single-use recovery code (SHA-256 hashed); stateless 5-minute Data Protection challenge bound to the security version | `TwoFactorService`, `LoginChallenges` |
| Login | per-account (5) + per-IP (20, NAT-friendly) throttle with increasing lockout; one message for unknown / wrong / disabled; **constant work for unknown logins (fixed in this review)** | `AuthService.LoginAsync`, `LoginThrottle` |
| Abuse | per-user token buckets on REST; 429 + Retry-After | `RateLimits.cs` |
| LiveKit admission | every `/rtc` entry point goes through Caddy `forward_auth` → `/internal/livekit/admission` (signature, lease, session, membership, Origin); LiveKit HTTP only on loopback; `access_token` and Authorization are removed from RTC access logs | `Caddyfile`, `VoiceService.AdmitAsync` |
| Webhook | signed JWT with a body sha256 claim; **body capped at 64 KB before buffering (fixed in this review; oversize → 413)**; handlers are idempotent compare-and-set updates | `VoiceEndpoints.cs`, `VoiceService.HandleWebhookAsync` |
| Internal routes | `/internal/*` answers 404 at the edge; the worker callback needs a ≥16-char key compared in constant time; the watchdog endpoint is loopback-only by network | `Caddyfile`, `SoundboardEndpoints.cs` |
| Headers | HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP, no `Server`; SPA CSP with `script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`; files get a sandbox CSP and CORP same-origin | `Caddyfile`, `FileEndpoints.Serve` |
| XSS | no `bypassSecurityTrust*`; the only `innerHTML` writes static icon SVG constants; message text goes through Angular interpolation | `apps/web` |
| SQL | EF parameterization everywhere; the only raw SQL interpolates compile-time `const` advisory-lock keys | `VoiceService`, `SoundPlaybackService` |
| Files | allowlist by magic bytes (images re-encoded by the validator, real plain text only), random storage keys with a strict key regex and full-path containment, outside the webroot; text always downloads; reads recheck channel access; missing bytes → 404 | `FileService`, `FileStore.PathOf` |
| Validator | no network, no secrets, read-only root, unprivileged, pids/memory limits, thread caps; filenames never reach the command line | `compose.prod.yml`, `validator.py` |
| Secrets | separate LiveKit keys for API, watchdog and publisher (the publisher gets short room-scoped tokens); secret files are root-owned in `/srv/hangar/config`; Data Protection keys persist and are backed up encrypted | `poc-bootstrap.sh`, backups |
| Supply chain | images pinned by digest, Python deps hash-locked, license gate in CI | `dependencies.md` |

## Open (decide before inviting people from outside the group)

- ~~Administrator 2FA~~: **built** (2026-10-18). Two-step login with an authenticator app (TOTP) and ten
  single-use recovery codes. It is optional per account, and the setup row recommends it for admins. Policy: the
  owner and anyone with Administrator should turn it on before outside invites. Enforcing it server-side is a
  possible follow-up. Secrets are Data-Protection-encrypted, codes can't be replayed, the challenge lasts 5 minutes
  and dies on a password change, and failures count toward the login throttle.
- **Malware scanning**: not needed while uploads are limited to re-encoded images and plain text. Adding any other
  type requires a scanning stage first.
- **HSTS preload / includeSubDomains**: deliberately not set until the domain's subdomains are known.
- Host-level adversarial tests (bypass ports, IPv6, TURN, token replay): pre-release-gates.md manual list.
