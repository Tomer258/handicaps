# ADR 002 — ASP.NET Core modular monolith

**Status:** Proposed. **Date:** 2026-10-17.

## Context

The brief prefers .NET and requires identity, durable APIs, policy enforcement, files and real-time application events.

## Alternatives

ASP.NET Core; NestJS/Node; a collection of microservices; adopting an existing communication product.

## Decision

Use ASP.NET Core 10 LTS in one deployable application with feature modules, EF Core/Npgsql and in-process services.

## Rationale

Built-in Identity, SignalR, validation and background-service support match the requirements. A monolith permits simple transactions for permissions, messages and sound reservations.

## Consequences

The LiveKit administration adapter uses typed HTTP/Twirp and JWT contracts. The narrow Python sound publisher and isolated validator add deployment work without owning business logic. Do not introduce a Node signing service by default.

## Reconsideration triggers

Reconsider when a demonstrated integration gap blocks .NET, business ownership truly divides across teams, or independently scaling application modules becomes necessary.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

