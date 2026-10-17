# ADR 009 — Cookies for the application, scoped JWTs for media

**Status:** Proposed. **Date:** 2026-10-17.

## Context

The app is browser-first, same-origin and invite-only, with persistent login and session revocation.

## Alternatives

Application JWTs in browser storage; encrypted cookie tickets with server sessions; external OIDC provider.

## Decision

Use secure HttpOnly cookies and PostgreSQL session records for Angular/API/SignalR. Issue short-lived room-specific LiveKit JWTs and gate every external signaling handshake against the active lease.

## Rationale

Cookies reduce first-party token handling. Server sessions permit immediate API revocation. Media uses the credential mechanism LiveKit expects while the admission gate closes the self-hosted stale-token rejoin path.

## Consequences

CSRF, Origin checks and long-lived hub revocation must be implemented. A short initial media TTL is insufficient because reconnect tokens refresh. Admission is a security-critical integration, not a proven built-in feature.

## Reconsideration triggers

Reconsider OIDC when SSO/external clients are required. If the gate fails adversarial tests, choose a proven alternative or explicitly revise the revocation requirement before release.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

