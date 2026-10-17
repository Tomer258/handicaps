# ADR 013 — Hosting provider and region

**Status:** Proposed. **Date:** 2026-10-17.

## Context

Israeli users need stable real-time paths and several to tens of TB of monthly outgoing media traffic.

## Alternatives

OVH Europe; Hetzner Germany; Contabo European VPS tiers; Israeli Kamatera/Interhost/JetServer.

## Decision

Provisionally prefer OVH European VPS-3 for the first measured trial. Retain Hetzner Germany as the second candidate. Purchase only after checking regional quote and evening routes.

## Rationale

The retrieved OVH configuration gives useful CPU/disk/network margin with high included transfer at a low starting price. Small metered-transfer plans can become much more expensive than their compute price.

## Consequences

No latency, packet-loss or VPS CPU advantage has been measured. Shared CPUs and fair-use conditions remain risks. Israeli plans need a comparable bandwidth/price quote; cheapest Contabo ports do not cover scenario C.

## Reconsideration triggers

Reconsider after ISP path tests, excessive loss/steal, a changed regional offer, unavailable capacity, or measured usage consistently exceeding a provider's traffic economics.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

