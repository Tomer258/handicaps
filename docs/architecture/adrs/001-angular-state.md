# ADR 001 — Angular state management

**Status:** Proposed. **Date:** 2026-10-17.

## Context

The app needs durable chat views, rapidly changing media state, and connections that outlive routed components. One developer must be able to understand every owner.

## Alternatives

NgRx global store; RxJS-only stores; service-owned Angular Signals with RxJS adapters.

## Decision

Use root media/audio/session services, feature stores with readonly Signals, computed derived state, and RxJS for asynchronous coordination. No NgRx initially.

## Rationale

This gives explicit lifetime and cleanup without action/reducer boilerplate. SDK Room, tracks and AudioNodes stay private to adapters rather than in serializable stores.

## Consequences

Teams must enforce one owner per state value and avoid duplicate Subject/Signal state. Route providers must not shadow root media services. Reconnection is a server protocol problem, not solved by a store.

## Reconsideration triggers

Reconsider if cross-feature optimistic workflows become difficult to coordinate, repeated consistency bugs appear, or multiple frontend teams require centralized event conventions.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

