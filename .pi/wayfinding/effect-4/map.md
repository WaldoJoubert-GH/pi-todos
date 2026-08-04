# Effect 4 Deep Adoption

**Label**: `wayfinder:map`
**Created**: 2025-08-04

## Destination

A spec document describing the full architecture of pi-todos rewritten as a deep Effect 4 program — covering the service layer, error channel, state management, scheduling, TUI bridge, tool registration, file I/O, and testing architecture. The spec is a handoff artifact for another dev to implement. End-state only; migration from the current imperative codebase is out of scope.

## Notes

- Domain: pi extensions, TypeScript, Effect 4 (`effect` npm package)
- Skills every session should consult: `/domain-modeling` (ubiquitous language), EFFECT_4 docs via context7
- The current codebase is ~1500 lines of imperative TS across 8 files — used as the functional baseline, not to be preserved
- pi's `ExtensionAPI` contract is the immutable boundary — everything inside it can change, the extension entry point interface cannot
- Nerd Font icons, Plane colors, and all UX constants carry forward unchanged

## Decisions so far

- [Testing Architecture Research](ticket-09-testing-architecture.md) — Vitest + `@effect/vitest`, mock `HttpClient` + `FileSystem` layers, `TestClock.adjust` for scheduled effects, `Ref.get` for state inspection, `Layer.succeed` for service substitution. Full findings in [research-testing.md](research-testing.md).
- [State Architecture](ticket-03-state-architecture.md) — Sync guards vanish (`Schedule.spaced` + `Effect.timeout`). Split `Ref` per concern (PlaneCache, Autotask hours, GitHub status, TimeEntry[], issues list). Running elapsed computed on tick, not stored. Overlay component reference eliminated — shared `Ref`s mediate command→TUI communication. Overlay-local UI state stays in the class.
- [Scheduling & Lifecycle](ticket-05-scheduling-lifecycle.md) — Cache-first two-phase bootstrap (`Ref.make` defaults → populate from disk → fork syncs). Conditional syncs via Layer provision (missing config = Layer.empty). Widget timer captures `setWidget` closure. Interrupt-only shutdown via `Scope.close` — all fibers cancelled, no `clearInterval` list. Per-sync `Schedule.spaced` + `Effect.timeout("30s")`.

## Not yet specified

- **Overall architecture coherence** — once service topology (01) and runtime integration (04) are resolved, the full program shape may need a synthesis pass
- **Error notification to widget/UI** — depends on 02 (error channel)
- **Specific test file structure and example tests** — testing patterns are resolved; needs a gelling pass once services are designed
- **`PiContext` service shape** — pi's `ctx.ui.*` methods wrapped as a service; partially covered by 04 (runtime integration), may sharpen into its own ticket after 04 resolves

## Out of scope

- Migration/implementation — this effort produces the spec, not the code
- Changing pi's `ExtensionAPI` — the external contract is fixed
- Changing UX behavior, icons, colors, or Plane/Sentry/Autotask API semantics
