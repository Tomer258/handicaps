# ADR 010 — Private local files before object storage

**Status:** Proposed. **Date:** 2026-10-17.

## Context

The initial deployment has one VPS and modest attachments and short sounds. Audio bytes need not live in PostgreSQL.

## Alternatives

Local persistent volumes; S3-compatible object storage; database blobs.

## Decision

Use private immutable local assets with database metadata and an IFileStore-style boundary. Validate in quarantine and keep encrypted independent backups.

## Rationale

This avoids object-storage credentials, per-request fees and another availability dependency while fitting the initial disk budget.

## Consequences

A host loss requires restore; quotas and orphan cleanup are mandatory. Files cannot become public through Caddy's static root. Snapshot consistency must include DB references and corresponding bytes.

## Reconsideration triggers

Move assets to object storage when storage quotas, multiple API hosts, backup duration or independent file availability justify it. Preserve immutable IDs and permission checks.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

