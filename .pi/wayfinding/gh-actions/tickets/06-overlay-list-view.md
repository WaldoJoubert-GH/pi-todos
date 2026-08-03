# How should the /actions overlay list view render?

<!-- label: wayfinder:prototype -->
<!-- blocked-by: 03-data-model.md, 04-nerd-font-icons.md -->
<!-- status: closed -->

## Question

Design the `/actions` overlay list view following the same two-level pattern as `/issues`:
- **List view**: one row per workflow run. Columns TBD — propose: status icon, workflow name, run #, branch, event, conclusion, relative time. Sort order? Default to most-recent-first.
- **Detail view** (Enter on a run): job-level breakdown. Each job shows its name, status icon, duration, and conclusion.
- **Navigation**: same keys as `/issues` (j/k or arrows, Enter for detail, Escape to go back/close).
- **Filtering?** All / by branch / by workflow? Or keep it simple initially.

Deliverable: a mock of the list view at ~80 columns showing mixed states (running, success, failure, queued) and a mock of the detail view for a failed run with multiple jobs.

## Resolution

Prototype delivered — [`docs/actions-overlay-design.md`](../../../docs/actions-overlay-design.md).

Design covers:
- **List view**: 7-column layout (status icon, workflow, run#, branch, event, conclusion, relative time) at 80 cols
- **Detail view**: metadata banner + job list with status, name, duration, conclusion, error hint
- **Key bindings**: Enter for detail, f for filter cycling (all/my/failed), r to rerun, Ctrl+Enter to open in browser
- **Filter**: `All` / ` My` / ` Failed` — mirrors /issues pattern
- **Data flow**: runs.json → list view → jobs/<id>.json on Enter → detail view
- **Widget integration**: third counter group ` N actions` when GitHub configured
- **Edge states**: empty, API error, no remote, no token — all covered
- Steps drill-down reserved for v2
