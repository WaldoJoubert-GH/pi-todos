# Tool Registration Bridge

**Parent**: [Effect 4 Deep Adoption](map.md)
**Label**: `wayfinder:grilling`

## Question

How do LLM tools (`get_todos`, `fetch_sentry_issue`) access live application state in the Effect 4 rewrite?

Currently `registerTools(pi, () => timeEntryState)` passes a closure that reads the module-level `timeEntryState` array. Tools are statically registered at startup.

- Do tools get a reference to the Effect runtime (via a `Runtime` or `FiberRef` snapshot) to run Effect programs?
- Or do tools receive pre-resolved service references (e.g. a `PlaneService` instance) and call them synchronously?
- If tools need to run Effect programs (e.g. `fetch_sentry_issue` calls the Sentry API), do they use `Effect.runPromise` internally, or are they themselves Effect generators invoked by a tool-layer runtime?
- How does `get_todos` read the current issues list — from a `Ref`, from a file, or from a service?
- The tool descriptions mention reading `issues.json` — does this detail live in the tool or is it abstracted behind a `ToolService`?
