# Error Channel Strategy

**Parent**: [Effect 4 Deep Adoption](map.md)
**Label**: `wayfinder:grilling`

## Question

What is the error channel design for the Effect 4 rewrite?

- Unified `AppError` ADT vs. per-service error types?
- If unified: what variants? (`PlaneApiError`, `SentryApiError`, `AutotaskApiError`, `NetworkError`, `FileError`, `ConfigError`, `GitHubApiError`?)
- How do errors carry context? (status code, raw body, retryable flag?)
- Error recovery strategy: where does `Effect.catchTag` / `Effect.retry` live? Per-service, at the command handler, or both?
- How do errors surface to the user? (widget error indicator, `ctx.ui.notify`, console in non-interactive mode?)
- Defect vs. expected error boundary — what's a defect (crash the fiber) vs. an expected error (typed channel)?
