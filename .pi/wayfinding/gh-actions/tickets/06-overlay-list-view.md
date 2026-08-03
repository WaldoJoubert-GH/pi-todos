# How should the /actions overlay list view render?

<!-- label: wayfinder:prototype -->
<!-- blocked-by: 03-data-model.md, 04-nerd-font-icons.md -->

## Question

Design the `/actions` overlay list view following the same two-level pattern as `/issues`:
- **List view**: one row per workflow run. Columns TBD — propose: status icon, workflow name, run #, branch, event, conclusion, relative time. Sort order? Default to most-recent-first.
- **Detail view** (Enter on a run): job-level breakdown. Each job shows its name, status icon, duration, and conclusion.
- **Navigation**: same keys as `/issues` (j/k or arrows, Enter for detail, Escape to go back/close).
- **Filtering?** All / by branch / by workflow? Or keep it simple initially.

Deliverable: a mock of the list view at ~80 columns showing mixed states (running, success, failure, queued) and a mock of the detail view for a failed run with multiple jobs.
