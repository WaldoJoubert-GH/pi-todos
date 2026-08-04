# Effect 4 Testing Architecture — Research Findings

**Researched**: 2025-08-04
**Resolves**: [ticket-09-testing-architecture](ticket-09-testing-architecture.md)

## 1. Version & Package Landscape

Effect 4 is currently in **beta** (`4.0.0-beta.x`). Key changes from v3:

- **Single version number**: All ecosystem packages (`effect`, `@effect/platform-*`, `@effect/vitest`, `@effect/sql-*`) share one version. Install `effect@4.0.0-beta.x` and matching `@effect/vitest@4.0.0-beta.x`.
- **Consolidation**: `@effect/platform` functionality (FileSystem, HttpClient, Path) is now **part of core `effect`**. Platform-specific packages remain separate (`@effect/platform-node`, `@effect/platform-bun`).
- **Keep-alive**: v4's runtime keeps the process alive for suspended fibers — no more `runMain` requirement.

## 2. Test Toolkit

### `@effect/vitest`

Official test integration. Requires `vitest ^3.0.0 || ^4.0.0`.

| API | Purpose |
|---|---|
| `it.effect` | Wraps effect in `TestContext` (provides `TestClock`, etc.) |
| `it.live` | Runs with real clock/runtime (no test doubles) |
| `it.scoped` | Provides a `Scope` for resource-acquiring effects |
| `it.scopedLive` | Scoped + live |
| `it.flakyTest` | For inherently flaky tests |

### `TestClock`

```typescript
it.effect("advance time", () =>
  Effect.gen(function*() {
    yield* TestClock.adjust("1000 millis")
    // clock now reads 1000ms
  }))
```

`TestClock.adjust` accepts strings like `"5 seconds"`, `"1 minute"`. Critical for testing scheduled/periodic effects — advance time in discrete jumps rather than waiting.

### Layer Substitution

Tests provide mock layers via `Live` convention:

```typescript
class PlaneService extends Context.Service<PlaneService, {
  readonly fetchIssues: () => Effect.Effect<PlaneIssue[], PlaneApiError>
}>()("pi-todos/PlaneService") {
  static readonly Live = Layer.effect(this, Effect.gen(function*() {
    // real implementation
  }))
  static readonly Test = Layer.succeed(this, {
    fetchIssues: () => Effect.succeed(mockIssues)
  })
}
```

Tests compose layers: `Effect.provide(program, PlaneService.Test)` or use `it.effect` with a scoped provide.

## 3. Testing HTTP (`fetch`-based services)

Effect's HTTP client is in `effect/unstable/http`:

- `FetchHttpClient.layer` — based on `globalThis.fetch` (works in Node 18+ without deps)
- Can be **substituted** with a mock `HttpClient` layer that returns stubbed responses
- No built-in "mock HTTP server" — provide a mock `HttpClient` service directly, or use real `fetch` with a test server (e.g. `msw`, `nock`, or a local `node:http` server)

Pattern for mocking fetch:

```typescript
// Define an HttpClient mock layer
const MockHttpClient = Layer.succeed(HttpClient.HttpClient, {
  execute: (request) => Effect.succeed(/* mock response */)
})
```

## 4. Testing File I/O

`FileSystem` service (core `effect`) provides:
- `readFile(path)` → `Uint8Array`
- `readFileString(path, encoding?)` → `string`
- `writeFile(path, data)`
- `writeFileString(path, data, options?)`

No built-in in-memory FileSystem in core. Two approaches:
1. **Mock the service**: Provide a `Layer.succeed(FileSystem, mockImpl)` backed by a `Map<string, string>`
2. **Temp directory**: Use Node's `fs.mkdtemp` with the real `NodeFileSystem` layer (integration test)

For unit tests, approach 1 is preferred.

## 5. Testing Scheduled/Periodic Effects

```typescript
it.effect("sync fires after 5 minutes", () =>
  Effect.gen(function*() {
    const fiber = yield* Effect.fork(syncLoop) // Schedule.spaced("5 minutes")
    yield* TestClock.adjust("5 minutes")
    // sync should have fired once
    yield* Fiber.interrupt(fiber)
  }))
```

- `TestClock.adjust` triggers scheduled effects synchronously
- Fork the periodic effect, advance clock, inspect state via `Ref`, interrupt fiber

## 6. Testing State Transitions

Inspect `Ref` state after running effects:

```typescript
it.effect("toggling timer stops running entry", () =>
  Effect.gen(function*() {
    const stateRef = yield* AppState
    yield* stopRunningEntry // effect that modifies Ref
    const state = yield* Ref.get(stateRef)
    expect(state.runningEntry).toBeNull()
  }))
```

No built-in property-based testing integration with `@effect/schema`. Use `fast-check` standalone or wait for community patterns to emerge.

## 7. Community Patterns

- Effect's own repo at `github.com/effect-ts/effect` has extensive test suites in `packages/*/test/`
- The `Live` + `Test` static layer convention is idiomatic
- Services are tested in isolation with `Test` layers; integration tests compose `Live` layers
- No widely-adopted "Effect test architecture guide" yet (v4 is beta)

## 8. Recommended Setup for pi-todos

```json
{
  "devDependencies": {
    "vitest": "^3.0.0",
    "@effect/vitest": "^4.0.0-beta.x"
  },
  "dependencies": {
    "effect": "^4.0.0-beta.x"
  }
}
```

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config"
export default defineConfig({
  test: { globals: true }
})
```

- Tests live alongside source: `extensions/src/plane.test.ts`
- Test Layers per service, shared mock fixtures in `extensions/src/test-helpers/`
- Three test categories: unit (mocked services), integration (real API with env vars), property-based (optional, `fast-check`)

## Decision Summary

| Question | Answer |
|---|---|
| Test runner | Vitest (`^3.0.0` or `^4.0.0`) |
| Effect integration | `@effect/vitest` |
| HTTP mocking | Mock `HttpClient` layer (no external mock server needed for unit tests) |
| File I/O mocking | Mock `FileSystem` layer backed by `Map` |
| Scheduled effect testing | `TestClock.adjust` + `Fiber.interrupt` |
| State inspection | `Ref.get` after effect execution |
| Property-based testing | Optional, use `fast-check` if desired |
