# ADR 007 — Separate audio tracks and receive-side mixing

**Status:** Proposed. **Date:** 2026-10-17.

## Context

The product has independent voice, screen-audio and soundboard volume and per-user effect mute requirements.

## Alternatives

Mix everything into microphone; one mixed soundboard track per room; per-play tracks; persistent per-actor sound tracks.

## Decision

Keep microphone, screen audio and effect sources separate. The server publisher lazily creates one sound track per actor in the room and keeps it idle/muted between plays.

## Rationale

A single room mix cannot mute one triggerer's effects independently. Reusing actor tracks reduces repeated negotiation and stabilizes attribution.

## Consequences

Receivers need a verified track registry and shared output mixer/limiter. Idle tracks must not continuously consume audio bandwidth. The fifteen-track arrangement must be proven on the pinned SDK. Sound activity must not drive a user's microphone-speaking indicator.

## Reconsideration triggers

Reconsider if client decoder/track limits appear in measurements, the pinned SDK cannot publish the chosen custom sources, or the product drops per-actor sound controls.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

