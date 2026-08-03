# ADR 0004: GitHub Actions Widget Pill

## Status

Proposed

## Context

The extension already has types (`GitHubRun`, `GitHubLatestCache`), a `github.ts` module with remote resolution, token loading, and time-formatters (`formatRelativeTime`, `formatElapsed`), and config-layer cache read/write. What's missing is the UI: how the latest run status renders in the always-visible widget alongside Plane state pills, Sentry count, Daily Total, and Running Entry.

## Decision

### Placement

The Actions pill lives on **line 1** of the widget, after the Daily Total segment. It's a single segment — never wraps to a second line. It only appears when GitHub is configured (token present + git remote resolves to `owner/repo`).

```
 3 todos   2 sentry   2h 15m   Passing · 41m ago
 3 todos   2 sentry   2h 15m   Failing · 12m ago
 3 todos   2 sentry   2h 15m   Running · 5m elapsed
 3 todos   2 sentry   2h 15m   Queued · waiting
```

### Icon + conclusion mapping

| Conclusion / Status | Icon | Nerd Font glyph | Hex color | Label |
|---|---|---|---|---|
| `success` |  | `nf-fa-check_circle` | `#22C55E` | Passing |
| `failure` |  | `nf-fa-times_circle` | `#EF4444` | Failing |
| `cancelled` |  | `nf-fa-times_circle` | `#9CA3AF` | Cancelled |
| `skipped` |  | `nf-fa-fast_forward` | `#9CA3AF` | Skipped |
| `timed_out` |  | `nf-fa-clock_o` | `#F59E0B` | Timed out |
| `action_required` |  | `nf-fa-exclamation_triangle` | `#F59E0B` | Needs action |
| `neutral` |  | `nf-fa-question_circle` | `#9CA3AF` | Neutral |
| `stale` |  | `nf-fa-exchange` | `#9CA3AF` | Stale |
| `in_progress` (running) |  | `nf-fa-spinner` | `#F59E0B` | Running |
| `queued` / `waiting` / `pending` |  | `nf-fa-hourglass_half` | `#9CA3AF` | Queued |

### Time display

- **Completed runs** (`status === "completed"`): `formatRelativeTime(run.updated_at)` → e.g. `41m ago`, `3h ago`, `2d ago`. Uses the conclusion to set the label and icon; time comes from `updated_at`.
- **In-progress runs** (`status === "in_progress"`): `formatElapsed(run.run_started_at)` → e.g. `12m 5s elapsed`. Label is `Running`, suffix is `elapsed` not `ago`.
- **Queued/pending** (`status === "queued" | "waiting" | "pending"`): No meaningful elapsed time yet — show the word `waiting` instead of a time.

### Edge states

| State | Detection | Widget output |
|---|---|---|
| No runs ever | `GitHubLatestCache.run === null` | ` No runs yet` |
| Auth failure | API returns 401/403 on fetch | ` GH auth error` |
| API error | Network error, 5xx, rate limit | ` GH API error` |
| Not a git repo | `resolveGitHubRepo()` returns `not_a_git_repo` | Segment absent entirely |
| No GitHub remote | `resolveGitHubRepo()` returns `no_github_remote` | Segment absent entirely |
| Not GitHub | `resolveGitHubRepo()` returns `not_a_github_repo` | Segment absent entirely |
| No token | `loadGitHubToken()` returns `null` | Segment absent entirely |

### Nerd Font codepoints

All icons chosen from the Private Use Area, consistent with the existing widget vocabulary (CONTEXT.md). No Unicode fallback.

| Purpose | Glyph | Codepoint | Nerd Font name |
|---|---|---|---|
| Success/passing |  | `f14a` | nf-fa-check_circle |
| Failure |  | `f00d` | nf-fa-times_circle |
| Running |  | `f110` | nf-fa-spinner |
| Queued |  | `f254` | nf-fa-hourglass_half |
| Cancelled |  | `f057` | nf-fa-times_circle |
| Skipped |  | `f04b` | nf-fa-fast_forward |
| Timed out |  | `f017` | nf-fa-clock_o |
| Needs action |  | `f06a` | nf-fa-exclamation_triangle |
| Neutral |  | `f059` | nf-fa-question_circle |
| Stale |  | `f0ec` | nf-fa-exchange |
| No runs |  | `f069` | nf-fa-info_circle |
| Error/auth |  | `f06a` | nf-fa-exclamation_triangle |

### `buildWidgetLines` signature change

```typescript
export function buildWidgetLines(
  planeCache: PlaneCache | null,
  sentryCount: number,
  runningEntry: TimeEntry | null,
  missingIssue: boolean,
  updateVersion: string | null,
  repoUrl: string | null,
  dailyTotalMs: number,
  projectIdentifier: string | null = null,
  ghStatus: GitHubWidgetStatus | null = null,  // NEW
): string[]
```

Where:

```typescript
interface GitHubWidgetStatus {
  /** null when repo has zero runs */
  run: GitHubRun | null;
  error?: "auth" | "api" | null;
}
```

`buildWidgetLines` appends the GH segment to the line-1 parts array:

```
const parts: string[] = [];
// ... existing Plane, Sentry, Daily Total segments ...

// GitHub Actions segment (appended last on line 1)
if (ghStatus) {
  parts.push(formatGhWidgetSegment(ghStatus));
}
```

---

## Mock widget lines

### Happy path — success

```
 3 todos   2 sentry   2h 15m   Passing · 41m ago
IP: 1  RV: 1  BK: 1
 PITODOS-42 Fix login redirect on session expiry
 #24 Refactor auth module — 1h 23m 15s
```

### Happy path — failing

```
 5 todos   1 sentry   3h 02m   Failing · 12m ago
IP: 2  TUP: 1  RV: 2
 PITODOS-42 Fix login redirect on session expiry
 PITODOS-47 Add rate limiting middleware
 #42 Fix login redirect — 41m 08s
```

### Happy path — in progress

```
 5 todos   1 sentry   3h 02m   Running · 5m 23s elapsed
IP: 2  TUP: 1  RV: 2
```

### Happy path — queued

```
 5 todos   1 sentry   3h 02m   Queued · waiting
IP: 2  TUP: 1  RV: 2
```

### No runs yet

```
 3 todos   2 sentry   1h 45m   No runs yet
IP: 1
```

### Auth error

```
 3 todos   2 sentry   1h 45m   GH auth error
IP: 1
```

### API error

```
 3 todos   2 sentry   1h 45m   GH API error
IP: 1
```

### No GitHub remote (segment absent)

```
 3 todos   2 sentry   1h 45m
IP: 1
```

### All clear — zero state + Actions present

```
 all clear   0h 00m   Passing · 2h ago
```

### All clear — zero state, no Actions

```
 all clear   0h 00m
```

---

## Consequences

- One new optional parameter on `buildWidgetLines` — backward compatible, no existing call sites break.
- Icons chosen for semantic distinctness: / for binary pass/fail,  for running (distinct from  used for Running Entry timer),  for queued.
- Error states use  (exclamation triangle), same glyph as sync errors — consistent visual vocabulary.
- Segment is fully absent when GitHub isn't configured, keeping the widget clean for non-GitHub users.
- Time formatters (`formatRelativeTime`, `formatElapsed`) already exist in `github.ts` and match the Elapsed style from CONTEXT.md (`Xh Ym Zs` with zero units dropped).
