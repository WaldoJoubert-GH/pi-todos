# What is the Actions data model and cache format?

<!-- label: wayfinder:grilling -->
<!-- blocked-by: 01-api-endpoints.md -->

## Question

Define the TypeScript types for `GitHubRun`, `GitHubJob`, `GitHubActionsCache`, and the cache file layout in `.dev/`. What lands in the unified `issues.json` (if anything — Actions are distinct from Plane/Sentry issues)? What's the cache file path? How do we handle the gap between what the API returns and what the overlay needs? Follow the domain language conventions from `CONTEXT.md` — invent new terms precisely.

This ticket also settles the `DevConfig` extension: what (if anything) goes in `.dev/config.json` under a `github` key, given that owner/repo is resolved from git remote and the token is a global secret.
