# ADR 0004: GitHub Actions Status Icons

## Status

Proposed

## Context

The widget uses Nerd Font Private Use Area codepoints from Font Awesome (v4.7, via Nerd Font's `nf-fa-*` set) for all TUI icons. We need icons for the 7 GitHub Actions run/job statuses that are:

1. **Visually cohesive** with the existing widget icon set:
   - `nf-fa-tasks` (U+F273 ) → Plane issues
   - `nf-fa-bug` (U+F188 ) → Sentry errors
   - `nf-fa-clock-o` (U+F017 ) → Daily Total
   - `nf-fa-check-circle` (U+F05E ) → All-clear zero-state
   - `nf-fa-exclamation-triangle` (U+F06A ) → Sync errors
   - `nf-fa-hourglass-2` (U+F252 ) → Running Entry timer
   - `nf-fa-download` (U+F019 ) → Updates
   - `nf-fa-chevron-right` (U+F054 ) → Selected row cursor

2. **No collisions** with any of those existing codepoints.

3. **Semantically clear** — each icon must unambiguously suggest its status even without a label.

## Decision

**Final set (reconciled from Widget ADR, timed_out fixed to avoid Daily Total collision):**

| GitHub Status | Icon Name | Codepoint | Character | Rationale |
|---|---|---|---|---|
| `queued` | `nf-fa-hourglass_half` | `U+F254` |  | Half-spent hourglass — waiting to start |
| `in_progress` | `nf-fa-spinner` | `U+F110` |  | Animated spinner — active execution |
| `success` | `nf-fa-check_circle` | `U+F14A` |  | Check in circle — passed |
| `failure` | `nf-fa-times_circle` | `U+F00D` |  | X in circle — failed |
| `cancelled` | `nf-fa-times_circle` | `U+F057` |  | Times circle — explicitly cancelled |
| `skipped` | `nf-fa-play` | `U+F04B` |  | Play/triangle — conditionally skipped |
| `timed_out` | `nf-fa-hourglass_3` | `U+F253` |  | Hourglass fully spent — time ran out |

⚠️ F017 (clock-o) excluded for timed_out because it collides with the Daily Total icon. F253 (hourglass_3) is the collision-free alternative. All other choices from the Widget ADR.

## Collision audit

Checked against all 15 existing PUA codepoints used in `extensions/src/tui.ts`:

```
Existing: F017 F019 F040 F054 F05E F06A F0A9 F0EC F0F1 F102 F103 F121 F188 F252 F273
Reconciled: F00D F04B F057 F110 F14A F253 F254

Intersection: (none)
```

All 7 proposed codepoints are unused in the current codebase.

## Visual cohesion

All icons are from the Font Awesome 4.7 set (Nerd Font `nf-fa-*`), which is the same icon family as all existing widget icons. They share the same weight, stroke style, and design language.

## Alternative considered: nf-devicons / nf-octicon

GitHub-native Octicons (`nf-oct-*`) use a different codepoint range (F400+). Mixing Octicons with the existing all-FA widget would break visual cohesion. The FA set is the right home for status icons alongside tasks, bug, and clock.

## Widget color convention

Following GitHub's own color semantics and the project's hex-based ANSI approach:

| Status | Hex | ANSI Name |
|---|---|---|
| `queued` | `#9CA3AF` | gray-400 (muted) |
| `in_progress` | `#F59E0B` | amber (active/warning) |
| `success` | `#22C55E` | green |
| `failure` | `#EF4444` | red |
| `cancelled` | `#9CA3AF` | gray-400 (muted) |
| `skipped` | `#6B7280` | gray-500 (muted-er) |
| `timed_out` | `#EF4444` | red (same severity as failure) |

## Consequences

- TypeScript constants for these codepoints will live in a new `extensions/src/github-icons.ts`.
- The widget line will show a compact run-status pill: `{icon} {conclusion}` for completed runs, `{icon} {status}` for in-flight runs.
- The GitHub Actions overlay (future) will use these icons per-row.
- Any Nerd Font-patched monospace font that supports the FA set will render these correctly — no additional font requirements.
