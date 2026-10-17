# Private Discord Alternative — Architecture Proposal

**Status:** Proposed; awaiting architecture approval. **Research date:** 17 October 2026. **Audience:** one developer using Codex and Claude Code. **Scope:** 15 friends, one private workspace, browser first. No application, infrastructure deployment, or proof of concept has been implemented.

## Recommendation

Use Angular 22, ASP.NET Core 10, PostgreSQL 18, SignalR, and one self-hosted LiveKit SFU. Deploy with Docker Compose on an Ubuntu 24.04 LTS VPS. Serve the Angular build with Caddy; no frontend Node server is needed in production. Keep the application a modular monolith and omit Redis initially.

The soundboard is part of the MVP. A small Python worker publishes normalized sounds as real LiveKit audio, with one track per triggering user. A separate restricted file-validation worker protects the application from malformed uploads. These are narrow media adapters, not independently owned business services.

Prefer an OVH European VPS-3 trial: the retrieved worldwide page advertises 6 vCores, 12 GB RAM, 100 GB NVMe, 2 Gbps and a starting price of $12.32/month. The original 4-vCPU/8-GB target is a reasonable pilot, but the four-stream maximum must pass a load test. Budget approximately $17–23/month for the recommended VPS, a domain allowance, and independent backup storage before tax, extras, or regional pricing differences. This is a planning allowance, not a checkout quote. See [capacity and hosting](capacity-and-hosting.md).

## Decisions that matter

1. **Browser support is a tested product boundary.** Windows Chrome and Edge are the release targets. Full-monitor, window, and tab capture are feasible; audio depends on the selected source, browser, OS, and consent. Window audio is no longer universally unsupported. Full-system loopback can recapture the call itself; headphones do not solve that digital feedback path.
2. **Media and application events have different transports.** REST commits data; SignalR distributes application events; LiveKit carries actual microphone, screen, camera, and soundboard media.
3. **Soundboard moderation is authoritative.** A server publisher reads only approved sounds. Client playback events alone are not the soundboard transport. Separate tracks preserve per-user soundboard mute and independent voice volume.
4. **Self-hosted media revocation needs more than short JWTs.** Require an application admission check at every external LiveKit signaling handshake, plus active participant removal and reconciliation. This integration is an early security gate, not a claimed built-in LiveKit capability.
5. **Bandwidth matters more than user count.** Peak modeled egress is 117/216/532 Mbps for scenarios A/B/C; the corresponding 120-hour monthly envelopes are 6.3/11.7/28.7 TB. These are calculations from explicit assumptions, not VPS benchmarks.

## Reading order

| Document | Purpose |
|---|---|
| [architecture.md](architecture.md) | Executive specification, frontend, backend, messaging and voice design |
| [browser-media-research.md](browser-media-research.md) | Compatibility matrix, screen/game audio, feedback and native limitations |
| [soundboard.md](soundboard.md) | Four alternatives, exact chosen audio path, volumes and moderation |
| [data-model-and-contracts.md](data-model-and-contracts.md) | Preliminary schema, indexes, API/event contracts and retention |
| [security-and-operations.md](security-and-operations.md) | Authentication, media admission, deployment, ports, recovery and backups |
| [capacity-and-hosting.md](capacity-and-hosting.md) | Reproducible calculations, hardware estimates and official price comparison |
| [diagrams.md](diagrams.md) | Eleven requested diagram views; ER view divided into three readable parts |
| [adrs/README.md](adrs/README.md) | Thirteen architecture decision records |
| [roadmap-and-testing.md](roadmap-and-testing.md) | Risk-first roadmap, acceptance gates and test matrix |
| [development-workflow.md](development-workflow.md) | Monorepo, coding conventions, CI and AI handoffs |
| [sources.md](sources.md) | Primary sources, retrieval date and evidence limitations |
| [validation.md](validation.md) | Documentation checks and explicitly unperformed runtime validation |

## Approval scope

Approval of this proposal authorizes planning the Phase 0 feasibility work; it is not an assertion that media performance has already been demonstrated. The proposed defaults are: Windows Chromium first; server-published soundboard; no E2EE claim; one European VPS; one application replica; private local files; no recording; no mandatory native companion. The provider and exact package versions are reconfirmed when implementation begins.

Four release gates cannot be waived by a successful UI demo: game audio without returning the call's audio; real remote soundboard audio; revoked media-token replay rejection; and sustained A/B/C load with real Windows clients. Failed gates have explicit fallback decisions in the roadmap.

## Evidence vocabulary

- **Documented:** supported by a linked primary source.
- **Design:** a decision proposed here; not a vendor promise.
- **Estimate:** arithmetic or an engineering budget, not a measurement.
- **Gate:** requires implementation or real-device testing before release.

No existing repository or AGENTS.md was present in the accessible workspace. The attached brief is the source of requirements. Requirements are mapped to documents and release gates in the roadmap.
