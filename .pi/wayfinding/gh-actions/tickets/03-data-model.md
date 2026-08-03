# What is the Actions data model and cache format?

<!-- label: wayfinder:grilling -->
<!-- blocked-by: 01-api-endpoints.md -->
<!-- assignee: agent -->
<!-- status: closed -->

## Question

Define the TypeScript types for `GitHubRun`, `GitHubJob`, `GitHubActionsCache`, and the cache file layout in `.dev/`. What lands in the unified `issues.json` (if anything — Actions are distinct from Plane/Sentry issues)? What's the cache file path? How do we handle the gap between what the API returns and what the overlay needs? Follow the domain language conventions from `CONTEXT.md` — invent new terms precisely.

This ticket also settles the `DevConfig` extension: what (if anything) goes in `.dev/config.json` under a `github` key, given that owner/repo is resolved from git remote and the token is a global secret.

## Resolution

### Cache files

| File | Contents | Refresh | Consumer |
|------|----------|---------|----------|
| `.dev/github/latest.json` | Single `GitHubRun` — the most recent run across all branches | Every 30s (1 API call) | Widget |
| `.dev/github/runs.json` | `GitHubActionsCache` — up to 30 runs | Every 5min (1 API call) | `/actions` overlay list view |
| `.dev/github/jobs/<run_id>.json` | `GitHubJobsDetail` — job list for a specific run | On demand when `Enter` pressed in overlay | `/actions` detail view |

Actions do **not** go in `issues.json` — they are a standalone overlay like `/times`.

### DevConfig

```typescript
// in DevConfig:
github?: {
  repo_override?: string;  // optional: "owner/repo" when git remote isn't GitHub
}
```

Empty `github: {}` is valid — owner/repo resolved from git remote by default.

### Types (implemented in extensions/src/types.ts)

- **`GitHubRun`** — slimmed from API: `id`, `name`, `display_title`, `status`, `conclusion`, `head_branch`, `event`, `run_number`, `workflow_id`, `created_at`, `updated_at`, `run_started_at`, `actor_login`, `html_url`
- **`GitHubJob`** — `id`, `run_id`, `name`, `status`, `conclusion`, `started_at`, `completed_at`, `steps[]`
- **`GitHubStep`** — `name`, `status`, `conclusion`, `number`, `started_at`, `completed_at`
- **`GitHubActionsCache`** — `fetched_at`, `owner`, `repo`, `total_count`, `runs[]`
- **`GitHubJobsDetail`** — `fetched_at`, `run_id`, `total_count`, `jobs[]`

### Sync strategy

- Widget: `GET /runs?per_page=1` every 30s → writes `latest.json`
- Overlay: `GET /runs?per_page=30` every 5min → writes `runs.json`
- Detail: `GET /runs/{id}/jobs` on Enter → writes `jobs/<id>.json` (matches Sentry pattern)
