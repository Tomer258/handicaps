# Repository and AI-assisted development workflow

This document describes future implementation conventions. It does not authorize starting application code before architecture approval.

## 1. Monorepo layout

| Path | Owner/content |
|---|---|
| `apps/web/` | Angular standalone features, shared UI and root adapters |
| `apps/api/` | ASP.NET host, modules, application services and infrastructure |
| `workers/sound-publisher/` | Narrow Python RTC adapter; no permission/business ownership |
| `workers/asset-validator/` | Sandboxed validation and canonical output preparation |
| `contracts/` | OpenAPI and versioned SignalR/internal worker schemas |
| `infra/` | Reviewed Compose/Caddy/LiveKit templates and release manifests |
| `tests/` | Cross-component integration, browser/media and load harnesses |
| `docs/architecture/` | This specification, ADRs, diagrams, compatibility evidence and risks |
| `docs/runbooks/` | Deploy, rollback, restore, key rotation and media diagnosis |

Use npm for the Angular workspace, the .NET SDK and one Python dependency/lock workflow. No Nx/Turborepo is required for one frontend and one API. Pin dependencies and use a small number of documented build/test commands. Create an AGENTS.md only during implementation setup, containing actual repository commands and the boundaries below; do not invent commands that have not been verified.

## 2. Coding conventions

Angular: strict TypeScript/templates, feature folders, standalone components, typed forms, readonly state exposure, explicit service lifetime, bounded lists, and deterministic track/listener cleanup. Components do not directly call raw LiveKit administration endpoints or store credentials. Keep capture behind a browser adapter so it can be tested without global monkey patches. Handle browser capability failures in the user flow.

.NET: async I/O, cancellation tokens, explicit transaction scope, parameterized EF queries, typed policies and typed external clients. Keep DTOs separate from EF entities. Prefer simple application services to a generic mediator/repository abstraction until actual duplication appears. API endpoints stay thin while use cases own permission and transaction logic. Enforce workspace scope in joins and foreign keys.

Workers: bounded queues/timeouts, explicit process/session epochs, no command execution from user strings, immutable asset references, typed command schemas and predictable error codes. The publisher does not query arbitrary user data or decide whether a user has a permission. The validator has no network access and cannot publish media.

## 3. Contracts and change control

Generate a typed Angular HTTP client from reviewed OpenAPI. Store SignalR event envelope/types separately because OpenAPI does not describe hub delivery. Worker commands and track registry have small versioned JSON schemas; test serialization and compatibility. Never share database entity classes as the frontend contract.

Each vertical slice states the requirement, ADRs it depends on, files/modules it may change, API/data changes, acceptance tests and out-of-scope work. If a decision changes, write a superseding ADR explaining evidence and migration consequences. Preserve the old record. Contract or permission changes require tests demonstrating old/stale-client behavior.

## 4. CI/CD and environments

Pull-request checks: formatting/lint, builds, meaningful unit tests, real PostgreSQL integration, API/SignalR contract tests, targeted Playwright smoke flows and dependency/secret scans. Run the heavier multi-client media and load suite on an isolated schedule or before media/security releases. CI fake media cannot certify Windows audio capture.

Development and test use separate credentials, databases and disposable files. Staging uses a separate temporary host/domain when testing real media, so load generation does not impair friends' calls. Production has immutable image digests, protected secrets, a reviewed migration and rollback plan, backup preconditions and health checks. A release manifest records the app commit, schema version, LiveKit/SDK/container versions, browser certification and configuration revision.

Review checkpoints: authentication/ACL; message commit/dedup; media admission/revocation; capture/feedback; soundboard remote path; private uploads; and backup restore. Do not deploy a feature merely because the frontend compiles. Keep host/dependency patches routine and plan media restarts with the users.

## 5. Codex and Claude Code handoff

At the start of a coding session, the agent reads repository instructions, the relevant ADRs and the latest task/handoff entry, then inspects the actual code before planning changes. It should not assume the entire architecture is already implemented. The handoff records implemented behavior, tested commands/results, open failures, migrations and next acceptance gate.

Ask agents to work on one bounded vertical slice, preserve unrelated files, and explain any new dependency. Require a concrete need before adding Redis, another service, a state library, a broad refactor or a new runtime. Do not replace Angular with React-based LiveKit example components. Do not let a media demo remove auth because it is easier to connect.

Use separate branches/worktrees if two coding tools are used concurrently; assign disjoint ownership and merge after review. Do not have both mutate the same working tree without coordination. This is a future workflow option, not delegated work in this architecture task.

For GitHub checkpoints, recommend a push when a coherent slice has passed its required checks and present the commits/tests for review. Ask the user before pushing/publishing unless the session or repository instructions already authorize it; keep one unambiguous rule in AGENTS.md and workflow docs. AI handoffs must never contain production secrets or live invitation links.

## 6. Definition of done for a slice

A slice is done when the requested behavior works, relevant failure paths are handled, its contract and permission tests pass, documentation reflects actual behavior, and no unexplained dependencies or unrelated refactors are included. For media slices, “works” includes actual remote decoded audio/video and resource cleanup. Before the first release, the full acceptance gates and restore drill remain mandatory.
