# Scheduling & Lifecycle

**Parent**: [Effect 4 Deep Adoption](map.md)
**Label**: `wayfinder:grilling`
**Status**: ✅ Resolved

## Question

How are background intervals and lifecycle hooks managed in Effect?

## Resolution

### 1. Bootstrap: cache-first, two-phase

Phase 1 — create empty `Ref`s, start widget timer immediately (shows zero-state). Phase 2 — populate `Ref`s from disk caches. Phase 3 — fork sync fibers. This guarantees the widget is visible before any network call.

```typescript
const bootstrap = Effect.gen(function*() {
  // Phase 1: create Refs with defaults
  const planeRef = yield* Ref.make<PlaneCache | null>(null)
  const issuesRef = yield* Ref.make<UnifiedIssue[]>([])
  const atHoursRef = yield* Ref.make(0)
  const ghStatusRef = yield* Ref.make<GitHubWidgetStatus>({ run: null, error: null })
  const timeEntriesRef = yield* Ref.make<TimeEntry[]>([])

  // Phase 2: populate from disk
  yield* loadCaches(planeRef, issuesRef, atHoursRef, ghStatusRef, timeEntriesRef)

  // Phase 3: fork sync fibers + widget
  yield* forkSyncs.pipe(Effect.forkScoped)
  yield* widgetLoop.pipe(Effect.forkScoped)
})
```

### 2. Conditional syncs via Layer provision

No `if` in bootstrap. A service that isn't configured can't be constructed — its Layer is `Layer.empty`. The sync effect for a missing service simply doesn't exist.

```typescript
const syncLayers = Layer.mergeAll(
  planeCfg ? PlaneSync.Live.pipe(Layer.provide(Layer.succeed(PlaneConfig, planeCfg))) : Layer.empty,
  atCfg ? AutotaskSync.Live.pipe(Layer.provide(Layer.succeed(AutotaskConfig, atCfg))) : Layer.empty,
  ghCfg ? GitHubSync.Live.pipe(Layer.provide(Layer.succeed(GitHubConfig, ghCfg))) : Layer.empty,
)
```

### 3. Widget timer captures `ctx.ui.setWidget`

pi supports `setWidget` from timer callbacks (current code does this). The widget fiber captures the function reference directly — no indirection layer.

### 4. Shutdown: interrupt-only

Persistence is eager — time entries saved on start/stop, sync caches written on successful fetch. `Scope` interruption on `session_shutdown` cancels all fibers. In-flight HTTP is aborted. No flush step needed.

### 5. Per-sync schedule

Each sync uses `Schedule.spaced` + `Effect.timeout`:

```typescript
const planeSync = Effect.forever(
  doPlaneSync(planeRef).pipe(Effect.timeout("30 seconds"), Effect.catchAll(() => Effect.void))
).pipe(Effect.schedule(Schedule.spaced("5 minutes")))
```

### 6. Lifecycle binding

```typescript
export default function(pi: ExtensionAPI) {
  const scope = Effect.runSync(Scope.make)

  pi.on("session_start", async (_event, ctx) => {
    const program = bootstrap.pipe(
      Effect.provide(PiContext.fromCtx(ctx)),
      Effect.provide(syncLayers),
      Effect.scoped
    )
    Effect.runForkIn(scope, program)
  })

  pi.on("session_shutdown", async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
}
```

`session_start` creates a managed scope. `session_shutdown` closes it — all fibers (4 syncs + widget) are interrupted cleanly. No `clearInterval` list.
