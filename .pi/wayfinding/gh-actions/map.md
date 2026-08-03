# GitHub Actions Integration

<!-- label: wayfinder:map -->

## Destination

Add a GitHub Actions integration to pi-todos that:
1. Renders a **widget pill** showing the latest workflow run's status icon + relative time ("41 min ago" / elapsed if running) across all branches.
2. Provides a **`/actions` overlay** with a list-of-runs view and a per-run detail view drilling into jobs — same two-level pattern as `/issues`.
3. Resolves the repo **per-project from CWD's git remote** with no config file.
4. **Requires a GitHub token** stored in `~/.pi/agent/secrets/github.json` with an interactive setup flow.

## Notes

- Follows the existing integration pattern: Plane, Sentry, Autotask → GitHub Actions is the fourth source.
- Domain language: consult `CONTEXT.md`. New terms (Workflow, Run, Job, Conclusion, Actor) will be added as part of this effort.
- All TUI icons use Nerd Font Private Use Area codepoints — no Unicode fallback.
- Widget, overlay, and tools each follow the existing conventions in `extensions/index.ts`, `src/tui.ts`, and `src/tools.ts`.
- Skills to consult: `/grilling`, `/domain-modeling`, `/research`, `/prototype`.

## Decisions so far

- [What GitHub Actions API endpoints do we call?](tickets/01-api-endpoints.md) — Three endpoints: list runs, get single run, list jobs. Latest-run-across-all-branches is a single `GET .../runs?per_page=1`. Rate limit 5,000/hr (negligible). PAT scope: `actions:read`.
- [How do we resolve owner/repo from CWD's git remote?](tickets/02-resolve-owner-repo.md) — `resolveGitHubRepo()` in `extensions/src/github.ts`. Prefers `origin`, falls back to first alphabetical GitHub remote. Supports HTTPS, SSH, and `ssh://` URL formats. Token at `~/.pi/agent/secrets/github.json`. Includes `formatRelativeTime` and `formatElapsed` helpers.
- [What is the Actions data model and cache format?](tickets/03-data-model.md) — Three cache files: `latest.json` (widget, 30s), `runs.json` (overlay, 5min), `jobs/<id>.json` (detail, on-demand). Slim types: `GitHubRun`, `GitHubJob`, `GitHubStep`. `DevConfig.github` has optional `repo_override`. Actions stay out of `issues.json`.

## Not yet specified

- Detail view layout (job-level drill-down) — hangs on data model + API response shape
- Sync strategy and polling interval — hangs on API rate limits from research ticket
- Pagination strategy for repos with many runs — hangs on API response shape
- `get_actions` LLM tool — hangs on data model
- Color scheme for run statuses in the TUI — hangs on icon choices
- Job-level time tracking or linking to Plane issues — speculative; revisit if surfaced

## Out of scope

- Multi-repo aggregation (per-project, single repo)
- Auth-less public repo support (token is required)
- Re-running or cancelling workflows from the overlay (read-only)
