# Runtime Integration

**Parent**: [Effect 4 Deep Adoption](map.md)
**Label**: `wayfinder:grilling`

## Question

How does the Effect runtime integrate with pi's `ExtensionAPI`?

- Does `export default function(pi)` become a thin shell that starts an Effect runtime, or does the runtime live inside pi's lifecycle?
- One runtime for the entire extension lifetime, or per-command runtimes? (If per-command, how does shared state like time entries and widget persist?)
- How does `pi.on("session_start", ...)` map to Effect? Is `session_start` the runtime bootstrap, with the runtime torn down on `session_shutdown` via `Scope`?
- How does `pi.registerCommand("issues", handler)` work? Does each handler call `Effect.runPromise` wrapping an Effect program, or are handlers themselves `Effect` generators?
- `ctx.ui.setWidget`, `ctx.ui.notify`, `ctx.ui.input`, `ctx.ui.custom` — these are pi-provided side effects. Do they live in a `PiContext` service layer, or stay as direct calls inside `Effect.sync`/`Effect.promise` wrappers at the handler boundary?
