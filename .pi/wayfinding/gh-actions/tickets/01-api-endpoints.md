# What GitHub Actions API endpoints do we call?

<!-- label: wayfinder:research -->
<!-- status: closed -->
<!-- resolved-by: research/gh-actions-api-endpoints -->

## Question

What are the GitHub REST API endpoints for listing workflow runs, listing jobs within a run, and fetching a single run's details? What are the rate limits, pagination conventions, and response shapes? Are there any gotchas with the Actions API (e.g., jobs API only returns for recent runs, artifacts considerations)? This is foundational — the data model, cache format, and sync strategy all depend on the answer.

## Resolution

Research complete — findings at [research/api-endpoints.md](../research/api-endpoints.md).

**Key decisions surfaced:**
- Three endpoints needed: list runs, get single run, list jobs for a run
- "Latest run across all branches" is a single `GET .../runs?per_page=1` call — efficient for widget
- Rate limit: 5,000 req/hr authenticated — negligible at 5-min poll (12 req/hr)
- Required PAT scope: `actions:read` (fine-grained) or `repo` (classic)
- Gotchas: run retention is 90 days; `name` can be null (use `display_title`); `conclusion` is null while `status != completed`
