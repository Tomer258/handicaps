# ADR 006 — Authoritative server soundboard publisher

**Status:** Proposed. **Date:** 2026-10-17.

## Context

Effects must travel as real room audio, work without the triggerer's mic, honor moderation, and support attribution.

## Alternatives

Browser mic mixing; separate browser-generated track; synchronized local playback commands; server RTC publisher.

## Decision

Use a narrow publish-only Python RTC worker reading approved normalized files. The .NET API owns authorization, rate limits, commands, deadlines and audit.

## Rationale

This enforces the official sound library and stop behavior and removes the triggerer's tab from the publication path. Local playback commands alone are not a LiveKit media stream.

## Consequences

One extra runtime/container and worker health are required. No LLM/Agents framework. Listeners still need autoplay unlock and may mute effects. A crash can lose a sound; do not retry ambiguously started playback.

## Reconsideration triggers

Reconsider a browser publisher only if the product explicitly accepts cooperative-client moderation and its lower reliability. Reconsider local-only playback only if actual shared-media interoperability is no longer required.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

