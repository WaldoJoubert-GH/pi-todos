# GitHub Actions REST API — Research Findings

> Resolves ticket: [01-api-endpoints](../tickets/01-api-endpoints.md)
> Sources: [GitHub REST API docs](https://docs.github.com/en/rest/actions/workflow-runs), [workflow jobs docs](https://docs.github.com/en/rest/actions/workflow-jobs), [rate limits docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

## Endpoints we need

### 1. List workflow runs for a repository

```
GET /repos/{owner}/{repo}/actions/runs
```

**Key query params:**
| Param | Values | Use |
|-------|--------|-----|
| `status` | `queued`, `in_progress`, `completed`, `waiting`, `pending`, `success`, `failure`, `cancelled`, `skipped`, `timed_out`, `action_required`, `neutral`, `stale`, `requested` | Filter by run status |
| `branch` | string | Filter to a specific branch |
| `event` | `push`, `pull_request`, `schedule`, `workflow_dispatch`, etc. | Filter by trigger event |
| `actor` | string (username) | Filter by who triggered |
| `per_page` | 1–100 (default 30) | Pagination |
| `page` | integer (default 1) | Pagination |
| `created` | date range | Filter by creation time |
| `exclude_pull_requests` | boolean (default false) | Exclude PR runs |

**Sorting:** Default is `created_at` descending (newest first). This is the default and is not configurable via query params — the API always returns newest first.

**Max results:** 1,000 per query (even with pagination). For repos with very high run volume, use `created` filter to narrow windows.

**Key response fields** (from `workflow_runs[]`):
```typescript
{
  id: number;              // unique run ID
  name: string | null;     // workflow name (e.g. "CI")
  display_title: string;   // human-readable title (e.g. "Fix login bug · 3fd8a1c")
  status: string | null;   // "queued" | "in_progress" | "completed" | "waiting" | "pending"
  conclusion: string | null; // "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "action_required" | "neutral" | "stale"
  head_branch: string | null;
  event: string;           // "push" | "pull_request" | "schedule" | etc.
  run_number: number;
  run_attempt: number;
  workflow_id: number;
  created_at: string;      // ISO 8601
  updated_at: string;      // ISO 8601
  run_started_at: string;  // ISO 8601 — when execution actually started
  actor: { login: string; avatar_url: string; ... };
  triggering_actor: { login: string; ... };
  html_url: string;        // link to run on GitHub
  jobs_url: string;        // full URL to jobs endpoint
}
```

### 2. Get a single workflow run

```
GET /repos/{owner}/{repo}/actions/runs/{run_id}
```

Same response shape as a single item from the list endpoint. No additional fields.

### 3. List jobs for a workflow run

```
GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs
```

**Query params:**
| Param | Values | Use |
|-------|--------|-----|
| `filter` | `latest` (default) or `all` | `latest` = only most recent attempt; `all` = all attempts |
| `per_page` | 1–100 (default 30) | Pagination |
| `page` | integer (default 1) | Pagination |

**Key response fields** (from `jobs[]`):
```typescript
{
  id: number;
  run_id: number;
  name: string;             // job name as defined in workflow YAML
  status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  started_at: string;       // ISO 8601
  completed_at: string | null;
  steps: Array<{
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: string | null;
    number: number;
    started_at: string | null;
    completed_at: string | null;
  }>;
  workflow_name: string | null;
  head_branch: string | null;
  html_url: string | null;
  runner_name: string | null;
}
```

## "Latest run across all branches" strategy

A single call with `?per_page=1` returns the most recent run:

```
GET /repos/{owner}/{repo}/actions/runs?per_page=1
```

This is **one API call** — efficient enough for both widget refresh and initial overlay load. The response includes `total_count` so we also get the total run count for free.

## Rate limits

| Tier | Limit |
|------|-------|
| Authenticated (PAT) | **5,000 requests/hour** |
| Enterprise Cloud org | 15,000 requests/hour |
| Unauthenticated | 60 requests/hour (irrelevant — we require token) |
| Secondary (per-minute bursts) | 900 REST API points/min (each GET = 1 point) |
| Concurrent requests | Max 100 |

**Impact on sync strategy:** With 5,000 req/hr, even aggressive polling (every 60s) is ~60 req/hr — well within limits. A 5-minute poll is ~12 req/hr, which is negligible. The widget "latest run" call is 1 req per UI refresh. Even refreshing every second, that's 3,600 req/hr — within limits but wasteful. Better to poll at 30–60s for the widget and share the cache with the overlay.

## Authentication

- Header: `Authorization: Bearer <token>`
- Accept: `application/vnd.github+json`
- `X-GitHub-Api-Version: 2022-11-28` (recommended)
- **Required PAT scopes:**
  - **Fine-grained:** `actions:read` permission on the repository
  - **Classic:** `repo` scope (grants full repo access — overprivileged, but simplest)
- For private repos, any valid token with read access works. For public repos, the token still needs `actions:read`.

## Gotchas

1. **Run retention:** Workflow run data is retained for **90 days** by default. Older runs return 404. This affects how far back the overlay can browse.
2. **Jobs `filter=latest`:** The default `latest` filter only returns jobs from the most recent run attempt. If a run was re-run, old attempts are hidden. Use `filter=all` to see all attempts.
3. **`status` vs `conclusion`:** `status` is the execution phase (`queued` → `in_progress` → `completed`). `conclusion` is the result only after `status=completed`. While running, `conclusion` is `null`. Must check both.
4. **`name` can be null:** Some older runs have a null `name`. Use `display_title` as fallback — it's always present.
5. **Pagination ceiling:** Max 1,000 results per query. For repos exceeding this, use the `created` date filter to narrow windows.
6. **No `workflow_name` on runs:** The run response doesn't include the workflow filename. Use `name` (the workflow's `name:` field) or `display_title`.
7. **`jobs_url` is absolute:** The run's `jobs_url` field is a full URL to the jobs endpoint — no need to construct it manually for detail drilling.
