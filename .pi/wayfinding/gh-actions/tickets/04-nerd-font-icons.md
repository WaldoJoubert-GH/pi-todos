# What Nerd Font icons for each run/job status?

<!-- label: wayfinder:prototype -->
<!-- blocked-by: 03-data-model.md -->

## Question

Pick Nerd Font Private Use Area codepoints for each GitHub Actions run/job status:
- `queued` / `pending`
- `in_progress` / running (animated spinner?)
- `success` / completed-passed
- `failure` / completed-failed
- `cancelled`
- `skipped`
- `timed_out`

Must be visually cohesive with the existing widget icon set (`` for Plane, `` for Sentry, `` for Daily Total, `` for Running Entry, `` for errors). Deliverable: a mapping table (status → codepoint → glyph description) and a quick visual test rendered in the TUI.
