# ADR 012 — One VPS deployment and failure model

**Status:** Proposed. **Date:** 2026-10-17.

## Context

Economy and maintainability matter more than high availability for fifteen friends.

## Alternatives

Single Compose host; separate app and media servers; managed services; Kubernetes.

## Decision

Use one Ubuntu VPS with Compose, private database/files, LiveKit embedded TURN, Caddy with its Layer 4 pattern, and narrow media workers.

## Rationale

This provides a manageable release and backup story. A stock HTTP proxy cannot serve TURN; using the established LiveKit routing pattern avoids a TCP 443 binding conflict.

## Consequences

The VPS is a single failure domain and media upgrades interrupt calls. Independent backups, resource limits and a restore drill are required. Four-vCPU sizing remains conditional at maximum load.

## Reconsideration triggers

Resize or split the SFU when sustained resource/network tests fail, or when acceptable downtime changes. Add replicas only after defining shared session, event, presence and worker ownership.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

