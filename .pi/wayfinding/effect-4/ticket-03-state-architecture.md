# State Architecture

**Parent**: [Effect 4 Deep Adoption](map.md)
**Label**: `wayfinder:grilling`
**Status**: ✅ Resolved

## Question

How is mutable application state structured in the Effect 4 rewrite?

## Resolution

### 1. Sync guards → `Schedule.spaced`

The four `let syncingX = false` guard booleans vanish. `Schedule.spaced("5 minutes")` serializes executions — won't start the next effect until the previous completes. Each sync effect wraps with `Effect.timeout("30 seconds")` to prevent a hung request from blocking the schedule forever.

```typescript
Effect.forever(
  syncEffect.pipe(Effect.timeout("30 seconds"))
).pipe(Effect.schedule(Schedule.spaced("5 minutes")))
```

### 2. Split `Ref` per concern

| Ref | Writer | Reader |
|---|---|---|
| `Ref<PlaneCache \| null>` | Plane sync | Widget, overlay |
| `Ref<number>` (Autotask hours) | Autotask sync | Widget |
| `Ref<GitHubWidgetStatus>` | GitHub latest sync | Widget |
| `Ref<TimeEntry[]>` | Time entry ops (start/stop) | Widget, tools |
| `Ref<string \| null>` | GitHub runs sync | Widget (optional) |
| `Ref<UnifiedIssue[]>` | All syncs, state changes, creates | Widget, overlay, tools |

Independent writers, zero contention. Widget reads 4-5 `Ref.get` calls per tick — atomic and cheap. Single-record `Ref<WidgetState>` rejected: Plane sync should not rewrite GitHub data.

### 3. Running elapsed — computed, not stored

Widget timer (`Schedule.spaced("1 second")`) computes elapsed live: `Clock.currentTime - entry.started_at`. No separate elapsed `Ref` — the widget is the sole consumer of elapsed time.

### 4. Overlay component reference — eliminated

The mutable `overlayComponent` handle is gone. Command handlers (`handleChangeState`, `handleCreateIssue`) write to shared `Ref`s (e.g. `Ref<UnifiedIssue[]>`). The overlay factory receives `Ref` references at construction and reads them in `render()`. No cross-boundary mutable handle.

### 5. Overlay-local UI state stays in the class

Filter selection, list cursor, detail/split view, input mode buffer — these are TUI-local concerns with no external reader. They live in the overlay class fields, not in Effect `Ref`s. The overlay class conforms to pi's `{ render, invalidate, handleInput }` contract unchanged.
