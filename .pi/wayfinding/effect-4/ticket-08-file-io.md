# File I/O Layer

**Parent**: [Effect 4 Deep Adoption](map.md)
**Label**: `wayfinder:grilling`

## Question

How is file I/O structured in the Effect 4 rewrite?

Currently `config.ts` uses synchronous `fs.readFileSync`/`fs.writeFileSync` for all persistence: config, issues, time entries, state cache, autotask cache, GitHub caches. This is ~200 lines of imperative file ops.

- Does the `FileSystem` service wrap Node's `fs` directly (using `Effect.sync` / `Effect.promise`)? Or does it use Effect's built-in `FileSystem` from `@effect/platform`?
- Sync vs. async: the current code is sync and called during `session_start` bootstrap. If async, does it delay the widget? Does Effect's `FileSystem` have sync variants?
- Is there a `ConfigService` abstraction that wraps `FileSystem` + knows the `.dev/` layout, or do services read/write files directly through `FileSystem` + path helpers?
- Serialization: JSON parse/stringify errors — handled at the `FileSystem` layer (returning typed errors) or at the service layer?
- The migration path (`migrateIfNeeded`) — is this a one-shot startup effect or part of `ConfigService`?
