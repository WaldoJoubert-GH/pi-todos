# Research: Better TUI Patterns for pi-todos

**Date:** 2025-07-11
**Status:** Research complete — recommendations ready

## Problem

The current `extensions/src/tui.ts` is ~3,000 lines of entirely hand-rolled TUI code. Every overlay (`UnifiedOverlay`, `TimesOverlay`, `ActionsOverlay`, `ReadmeOverlay`) builds its UI from raw strings with manual box-drawing characters, manual column math, manual scroll management, and manual keyboard dispatch. None of Pi's built-in composable TUI components are used.

## What Pi Provides (unused by pi-todos)

Pi ships `@earendil-works/pi-tui` with these composable components:

| Component | What it does | How pi-todos could use it |
|---|---|---|
| **`Container`** | Groups children vertically, handles layout | Root for any overlay instead of manual line arrays |
| **`Box`** | Container with padding + background color | Section framing in detail views |
| **`Text`** | Multi-line text with word wrapping | Replace manual `padOrTrunc` + `wrapText` calls |
| **`DynamicBorder`** | Themed border frame (from `pi-coding-agent`) | Replace all manual box-drawing (`\u250C\u2500...`) |
| **`SelectList`** | Interactive list with fuzzy search, theming, scroll | Replace the entire issue list rendering in `UnifiedOverlay.render()` |
| **`Markdown`** | Renders markdown with syntax highlighting | Replace raw text rendering in `ReadmeOverlay` and detail views |
| **`Spacer`** | Empty vertical space | Replace manual `lines.push("")` |
| **`Input`** | Text input with cursor, IME support | Replace the hand-rolled create-issue input mode |
| **`BorderedLoader`** | Spinner with cancel (from `pi-coding-agent`) | Loading states for sync/API calls |
| **`SettingsList`** | Toggle settings with optional search | Could be adapted for state-group filter toggles |

Pi also provides these patterns via `ctx.ui`:

| Pattern | What it does | Current pi-todos state |
|---|---|---|
| **`setWidget`** | Persistent widget above/below editor | ✅ Already used for the status bar |
| **`setStatus`** | Footer status indicator | ❌ Not used |
| **`setFooter`** | Custom footer replacement | ❌ Not used |
| **`overlayOptions`** | Anchor, margin, sizing, responsive visibility | ⚠️ Used but only basic `top-left, 100%` |
| **`overlay focus`** | Focus management between overlays | ❌ Not used |

## Concrete Anti-Patterns in Current Code

### 1. Pre-baked theme colors in cached strings (breaks theme changes)

The Pi TUI docs explicitly warn about this:

> If a component pre-bakes theme colors into strings (via `theme.fg()`, `theme.bg()`, etc.) and caches them, the cached strings contain ANSI escape codes from the old theme.

Current code does this everywhere:

```typescript
// tui.ts — pre-bakes theme colors into cached lines
render(width: number): string[] {
  if (this.cachedLines && this.cachedWidth === width) {
    return this.cachedLines;  // ← returns stale ANSI codes on theme change
  }
  // ...
  lines.push(B("\u250C\u2500 ") + t.fg("accent", title) + ...);
  this.cachedLines = lines;  // ← caches pre-baked colors
}
```

The `invalidate()` method only clears the cache — it doesn't rebuild. Theme changes are invisible until the next manual re-render.

### 2. Manual box-drawing everywhere (no DynamicBorder)

```typescript
// Current: ~15 occurrences of manual border drawing per overlay
const B = (s: string) => t.fg("border", s);
lines.push(B("\u250C\u2500 ") + t.fg("accent", title) + B(" " + "\u2500".repeat(topDash) + "\u2510"));
lines.push(B("\u251C" + "\u2500".repeat(innerW) + "\u2524"));
lines.push(B("\u2514" + "\u2500".repeat(innerW) + "\u2518"));
```

Should be:
```typescript
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
```

### 3. Manual list rendering (no SelectList)

The `UnifiedOverlay.render()` method is ~200 lines, most of which reimplements list selection, scrolling, multi-select, chevron indicators, and truncation. `SelectList` has all of this built in:

- Built-in keyboard navigation (arrows, home, end, page up/down)
- Built-in fuzzy text filtering (type to filter)
- Built-in scroll with indicators
- Theme callbacks for selected/description/scroll elements
- `onSelect`, `onCancel`, `onSelectionChange` callbacks

### 4. Manual scroll management duplicated 4× 

Every overlay class implements its own:
- `scrollOffset`, `visibleHeight` fields
- `ensureVisible()` method
- Scroll indicator rendering
- Boundary clamping

### 5. Manual keyboard dispatch chains

The `handleInput` method in `UnifiedOverlay` is ~200 lines of nested if/else with 20+ key bindings. There's no keybinding map, no action dispatch — just raw conditional chains.

### 6. Manual text truncation/wrapping utilities

```typescript
function padOrTrunc(str: string, len: number): string { ... }
function wrapText(text: string, width: number): string[] { ... }
```

These reimplement `truncateToWidth` and `wrapTextWithAnsi` which are already exported from `@earendil-works/pi-tui`.

## Recommended Architecture

### Phase 1: Foundation — Replace borders & containers

Replace manual box-drawing with `DynamicBorder` + `Container` + `Text` composition. This is low-risk because it changes only rendering, not behavior.

**Before:**
```typescript
const B = (s: string) => t.fg("border", s);
lines.push(B("\u250C\u2500 ") + t.fg("accent", title) + B(" " + "\u2500".repeat(topDash) + "\u2510"));
lines.push(B("\u2502") + content + B("\u2502"));
lines.push(B("\u2514" + "\u2500".repeat(innerW) + "\u2518"));
```

**After:**
```typescript
import { Container, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";

container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));   // top
container.addChild(new Text(titleContent));
// ... body components ...
container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));   // bottom
```

### Phase 2: Replace the issue list with SelectList

The `UnifiedOverlay` list view can be largely replaced by `SelectList` with custom items. This handles:

- Arrow key navigation (↑↓ home end pgup pgdn)
- Scroll management with overflow indicators
- Fuzzy text filtering (bonus win: type to filter issues)
- Theme-based styling for selected vs unselected rows

**Challenge:** SelectList is designed for simple value/label/description items. pi-todos needs multi-column rows (slug, title, state pill, priority). This would require one of:

1. **Extend `SelectList`** with custom row rendering (check if `renderItem` is overridable)
2. **Use `SelectList` per-column + sync selection** (hacky)
3. **Keep custom list rendering but wrap in Container** (partial win — still gets Container layout)

Looking at the `SelectList` source, it has `renderItem` as a private method. Not overridable. So we would need option 3 — keep custom list rendering but use Container/DynamicBorder for the frame.

**Alternative:** Use `SelectList` for simpler overlays (`TimesOverlay`, `ReadmeOverlay` navigation) where the row format is simple enough. The issue list can stay custom but wrapped in proper components.

### Phase 3: Replace the create-issue input with `Input` component

The current input mode manually handles `decodeKittyPrintable`, backspace, and enter. The `Input` component from `@earendil-works/pi-tui` handles all of this plus IME support.

### Phase 4: Extract shared scrolling/list behavior

Extract a base class or composable for the scrolling list pattern shared across all overlays. This eliminates the 4× duplicated `scrollOffset`, `visibleHeight`, `ensureVisible()` code.

### Phase 5: Fix theme invalidation

Components that use theme colors must rebuild on `invalidate()`. The current pattern of clearing `cachedWidth`/`cachedLines` is not enough — the themed strings are pre-baked into the cache. Either:

1. Rebuild content in `invalidate()` (docs pattern: `updateDisplay()` called from `invalidate()`)
2. Switch to using theme as a function callback that's called during render (the `Container` + `Text` approach does this naturally)

### Phase 6: Proper overlay positioning

Currently all overlays use `anchor: "top-left", width: "100%", maxHeight: "100%"` — they take over the full terminal. Consider:

- **Side panel** for issue detail (50% width, right-anchored) — keeps list visible
- **Responsive visibility** — hide sidebar on narrow terminals
- **Proper margins** — use `margin: 1` instead of padding in content

## Effort Estimate

| Phase | Scope | Risk | Reward |
|---|---|---|---|
| 1: Borders & Containers | ~200 lines changed | Low | Visual consistency, theme support |
| 2: SelectList for simple lists | ~100 lines changed | Low | Free fuzzy search, proper keyboard |
| 3: Input component | ~50 lines changed | Low | IME support, proper cursor |
| 4: Extract shared behavior | ~150 lines moved | Medium | DRY, easier to add overlays |
| 5: Theme invalidation | ~100 lines added | Medium | Theme changes work correctly |
| 6: Overlay positioning | ~50 lines changed | Low | Better UX on wide terminals |

**Total:** ~650 lines changed/added across phases, with the 3,000-line file likely shrinking to ~2,200 lines.

## What NOT to Change

These parts of the current TUI are working well and use Pi's API correctly:

1. **`buildWidgetLines()`** — The widget is already using `ctx.ui.setWidget()` correctly. The line building is appropriate for a simple string array.

2. **`showOverlay()` factory pattern** — The `ctx.ui.custom()` factory + `overlay: true` pattern is correct. The `overlayOptions` usage is valid.

3. **`requestRender` callback** — The async re-render trigger pattern is correct.

4. **Gantt chart** — This is genuinely custom rendering (colored bars, timeline headers, today-line) that doesn't have a built-in equivalent. Keep it manual.

5. **State pills and color helpers** — `hexToAnsi`, `statePill`, `priorityLabel` are domain-specific and well-factored. Keep them.

## Key Files to Study

| File | What to learn |
|---|---|
| `pi-coding-agent/examples/extensions/preset.ts` | `SelectList` + `DynamicBorder` + `Container` pattern |
| `pi-coding-agent/examples/extensions/tools.ts` | `SettingsList` + `DynamicBorder` pattern |
| `pi-coding-agent/examples/extensions/todo.ts` | Simple `ctx.ui.custom()` with manual render |
| `pi-coding-agent/examples/extensions/overlay-qa-tests.ts` | Overlay positioning, stacking, focus, margins |
| `pi-tui/dist/components/select-list.d.ts` | `SelectList` public API |
| `pi-tui/dist/components/input.d.ts` | `Input` component API |
| `pi-coding-agent/docs/tui.md` | All patterns, theming, best practices |

## Decision

**Recommend phased approach starting with Phase 1 (borders + containers).** This is low-risk, immediately improves visual consistency, and sets up the composition pattern for later phases. Phase 2 (SelectList) should follow only for the simpler overlays (Times, Actions list) since the issue list's multi-column format isn't a natural fit for SelectList's value/label/description model.
