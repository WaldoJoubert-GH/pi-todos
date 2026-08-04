# TUI Overlay Integration

**Parent**: [Effect 4 Deep Adoption](map.md)
**Label**: `wayfinder:prototype`

## Question

How do the TUI overlay components (`UnifiedOverlay`, `TimesOverlay`, `ActionsOverlay`) interact with Effect-managed state?

pi's `ui.custom()` contract is synchronous and imperative: it expects a factory returning `{ render(width): string, invalidate(): void, handleInput(data): void }` with a `done(result)` callback for teardown. The overlay components are stateful classes today.

- Can the overlays remain as classes that receive `Ref` references from the Effect runtime, reading/writing via `.get`/`.set`? Or should they become Effect-managed state machines?
- If Effect-managed: how does the synchronous `render()` method work? Does it snapshot a `Ref` at render time?
- Input handling (`handleInput`) triggers state changes and pi calls `tui.requestRender()`. Does input dispatch into an Effect fiber (`Effect.runSync`?), or directly mutate a `Ref` that `render()` reads?
- The overlay's `done(null)` callback closes the overlay. How does this trigger cleanup (stopping the running entry's timer if the overlay closes)?
- `showOverlay`, `showTimesOverlay`, `showActionsOverlay` are async functions with 100+ line argument lists. Can they become simpler service calls?
