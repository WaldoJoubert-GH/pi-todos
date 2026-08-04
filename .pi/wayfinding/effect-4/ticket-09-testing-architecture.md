# Testing Architecture Research

**Parent**: [Effect 4 Deep Adoption](map.md)
**Label**: `wayfinder:research`
**Status**: ✅ Resolved ([findings](research-testing.md))

## Question

What is the recommended testing architecture for an Effect 4 application targeting a pi extension?

## Resolution

- **Test runner**: Vitest (`^3.0.0` or `^4.0.0`) with `@effect/vitest`
- **HTTP mocking**: Mock `HttpClient` layer — no external mock server needed for unit tests
- **File I/O mocking**: Mock `FileSystem` layer backed by `Map<string, string>`
- **Scheduled effects**: `TestClock.adjust` + fork the periodic effect, inspect state via `Ref`, interrupt fiber
- **State inspection**: `Ref.get` after running effects
- **Layer substitution**: `Layer.succeed(Service, mockImpl)` per service, `Live` + `Test` convention
- **Property-based testing**: Optional, `fast-check` standalone
- Full findings: [research-testing.md](research-testing.md)
