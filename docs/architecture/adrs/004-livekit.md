# ADR 004 — LiveKit rather than lower-level media infrastructure

**Status:** Proposed. **Date:** 2026-10-17.

## Context

The application needs voice, camera, screens, multiple tracks, reconnection, subscriptions and a server sound publisher.

## Alternatives

LiveKit; mediasoup; Janus; Jitsi integration; custom WebRTC infrastructure.

## Decision

Choose a pinned self-hosted LiveKit release with the JS client SDK and Python RTC SDK. Build the Angular interface directly without a React component dependency.

## Rationale

Room/track abstractions, administration APIs and embedded TURN reduce the amount of media infrastructure one developer must own. Mediasoup offers more low-level control but requires more orchestration.

## Consequences

LiveKit protocol, token and source semantics become integration dependencies. Its self-hosted revocation limitation needs the proposed admission gate. Validate custom tracks and Caddy routing early.

## Reconsideration triggers

Reconsider if Phase 0 cannot satisfy admission or sound-track behavior, a required codec/capture path fails, or measured deployment economics favor a managed media provider.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

