# ADR 011 — Browser first with an explicit native boundary

**Status:** Proposed. **Date:** 2026-10-17.

## Context

Most users run Chrome/Edge on Windows and installation is not mandatory. Games and global shortcuts expose OS-specific constraints.

## Alternatives

Web only; PWA; browser extension; Electron/WebView/native companion.

## Decision

Release browser-first for certified Windows Chromium combinations. Offer focused shortcuts and capability-based capture/audio fallbacks. No promised system-wide hotkeys.

## Rationale

This meets access requirements while avoiding installer/update/signing work. Current window-audio and own-audio exclusion options deserve real tests before a native dependency is assumed.

## Consequences

Global hotkeys, universally isolated per-process audio and browser-independent background lifecycle remain conditional/native capabilities. A PWA does not remove these limits.

## Reconsideration triggers

Add a companion only if Phase 0 cannot meet the agreed game-audio experience or users make global hotkeys mandatory. Keep its privileges and purpose narrow.

## Supporting specification

See the [main specification](../architecture.md), [media research](../browser-media-research.md), [soundboard](../soundboard.md), [security and operations](../security-and-operations.md), and [capacity/hosting evidence](../capacity-and-hosting.md) as applicable.

