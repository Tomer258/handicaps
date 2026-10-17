# CLAUDE.md — Hangar

## Workspace boundary (MANDATORY)

- This folder (`new discord/`) is the **only** filesystem root you may use. Everything outside it is invisible to you.
- Do NOT read, write, create, or delete anything on `C:\`, `D:\`, or any other path outside this folder — no user-profile dirs, no system temp, no global config.
- Temporary files go in `./.tmp/` (git-ignored), never in the system temp or a scratchpad outside this folder.
- Memory / session-heartbeat files live in `./.claude/memory/` (see below), not in `~/.claude`.
- Tool caches (npm, NuGet, pip) are configured to live inside this folder where possible.
- Do not install anything globally. Project-local tooling only.

## Session memory / heartbeat

Context may be auto-compacted. To survive that:

1. At session start, read `./.claude/memory/HEARTBEAT.md` (current status, next step) and `./.claude/memory/DECISIONS.md`.
2. After finishing each slice (or every ~30–40 minutes of work), update `HEARTBEAT.md`: what is done, what is in progress, exact next step, verified commands.
3. If you are running low on tokens, stop, update `HEARTBEAT.md` with a full handoff summary, and end the session.

## Source of truth

- `docs/architecture/` — architecture proposal (normative): stack, schema, contracts, soundboard, security, roadmap, ADRs.
- `docs/design/` — Claude Design canvas export ("Hangar"). `Main.dc.html` has the reference CSS (lines ~13–232), markup (~233–1224) and prototype logic (~1225–1883); `Handoff.dc.html` has the 20 component specs; `System.dc.html` tokens; `States.dc.html` UX states; `Responsive.dc.html` breakpoints; `Soundboard.dc.html` popover concept A.
- Deviations from the architecture are recorded in `.claude/memory/DECISIONS.md` (e.g. Angular 21 instead of 22).

## Git

- Commit after each verified slice. **Never push.**
