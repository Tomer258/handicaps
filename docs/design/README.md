# Hangar — design canvas export

Private Discord-style app for ~15 friends: voice, streaming, multi-stream viewing and a soundboard.

## Contents (`project/`)

| File | What it is |
|---|---|
| `canvas.json` | Canvas index: artboard positions, sizes and titles |
| `Main.dc.html` | Interactive prototype (1440 × 900): chat, voice, streams, soundboard, upload, settings |
| `Soundboard.dc.html` | Soundboard placement — Concept A (popover, selected) vs B (docked) + tile states |
| `System.dc.html` | Design system: color tokens, type scale, spacing, radii, motion, controls |
| `States.dc.html` | 18 UX states (15-person voice, buffering, permission denied, cooldown…) |
| `Responsive.dc.html` | 1920 / 1440 / 1366 / narrow / mobile layouts + breakpoints |
| `Handoff.dc.html` | Angular handoff: 20 component specs, tokens, services, audio buses |

## Opening the files

These are Design Component (`.dc.html`) files from the Claude Design canvas. They load
`./support.js`, which the canvas provides, so they **won't render correctly if opened
directly in a browser**. To view or edit them, open the canvas, or re-import
these files into a Design canvas.

The markup, CSS and the `<script type="text/x-dc">` logic blocks are readable as plain source
and can serve as reference while building the Angular app. The prototype is not production code.

## Notes

- Video feeds, the browser share picker, mic levels and notification permission are simulated.
- Soundboard sounds are synthesized in-browser with Web Audio (original, no licensed samples).
- Fonts: Bricolage Grotesque, Geist, Geist Mono (Google Fonts).
