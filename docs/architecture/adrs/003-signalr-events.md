# ADR 003 — SignalR application event distribution

**Status:** Proposed. **Date:** 2026-10-17.

## Context

Messages must survive disconnections and edits/deletes must converge. Media transport has different latency and bandwidth properties.

## Alternatives

SignalR; raw WebSockets; LiveKit data channels for all events; database polling.

## Decision

Use REST for durable commands/history and SignalR for post-commit events and ephemeral presence. Store a per-channel event/outbox log in PostgreSQL.

## Rationale

This keeps one source of truth while using an established .NET connection library. Cursor synchronization repairs gaps after reconnect; raw socket code would duplicate infrastructure.

## Consequences

Delivery is at least once with deduplication; SignalR is not a durable queue. Revalidate recipients and reconstruct groups. One replica permits an in-process connection registry without a backplane.

## Reconsideration triggers

Reconsider a backplane/shared presence when adding API replicas. Revisit the event protocol when retention or large fanout makes per-channel delta retrieval inadequate.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

