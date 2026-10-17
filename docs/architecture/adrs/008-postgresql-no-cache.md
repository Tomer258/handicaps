# ADR 008 — PostgreSQL without additional caching infrastructure

**Status:** Proposed. **Date:** 2026-10-17.

## Context

Fifteen users generate modest durable application load. Consistency matters more than avoiding every database query.

## Alternatives

PostgreSQL alone; PostgreSQL plus Redis; broker-based events and jobs.

## Decision

Use PostgreSQL for messages, sessions, outbox, short-lived command state and atomic rate reservations. Use bounded in-process caches only for non-authoritative metadata. No Redis initially.

## Rationale

Transactions solve send/dedup/cooldown races directly. One LiveKit node can operate without Redis; one API instance does not require a SignalR backplane.

## Consequences

Presence is reconstructable in memory and disappears on restart. The database remains a dependency for joins and sensitive actions. Cleanup keeps event/job tables bounded.

## Reconsideration triggers

Add Redis for supported multi-node LiveKit coordination or another measured need. Adding API replicas requires a deliberate shared-state/backplane design rather than copying the current process.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

