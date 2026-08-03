# `/actions` Overlay Design — Mockups

Follows the two-level pattern from `/issues`: **list view → detail view** via Enter/Escape.
Mockups at 80 columns. Icons from Nerd Font (FiraCode). Theme tokens: `border`, `accent`, `text`, `muted`, `dim`, `error`, `info`, `selectedBg`.

---

## 1. List View — Mixed States

Five runs with different statuses/conclusions, showing all visual states.

```
┌─ Actions (5) [All] ────────────────────────────────────────────────────┐
│ Status  Workflow        Run      Branch       Event       Conclusion  │
├────────────────────────────────────────────────────────────────────────┤
│        CI              #42      main         push        success  2m │
│        Deploy          #41      main         push        failure  5m │
│        Test Suite      #40      feat/auth    pull_req    in_prog  now│
│        Lint            #39      main         push        cancelle 1h │
│        Nightly Scan    #38      main         sched       queued  12m │
│      3 more                                                          │
├────────────────────────────────────────────────────────────────────────┤
│   scroll  Enter details  Ctrl+Enter open  r rerun  f filter  Esc    │
└────────────────────────────────────────────────────────────────────────┘
```

### Column widths (inner 78 cols)

| Column      | Width | Content                                          |
|-------------|-------|--------------------------------------------------|
| Status      | 8     | Nerd Font icon + 1 space padding                 |
| Workflow    | 16    | Truncated with `…` after 15 chars                |
| Run         | 8     | `#` + run_number, right-padded                   |
| Branch      | 12    | Truncated with `…` after 11 chars                |
| Event       | 10    | Short form: push, pull_req, sched, wf_disp, tag  |
| Conclusion  | 10    | Status text (in_progress/queued for active runs) |
| Relative    | 8     | Right-aligned, live-updating for active runs     |

### Status icons (Nerd Font Private Use Area)

| GitHub Status   | Icon | Codepoint | Description                |
|-----------------|------|-----------|----------------------------|
| success         |     | `\uF00C`  | nf-fa-check                |
| failure         |     | `\uF141`  | nf-fa-times_circle (red)    |
| in_progress     |     | `\uF017`  | nf-fa-clock-o (amber anim) |
| queued/pending  |     | `\uF252`  | nf-fa-clock-o (muted)      |
| cancelled       |     | `\uF28B`  | nf-fa-ban (dim)            |
| skipped         |     | `\uF068`  | nf-fa-minus (dim)          |
| timed_out       |     | `\uF254`  | nf-fa-hourglass-end (dim)  |
| action_required |     | `\uF06A`  | nf-fa-exclamation_triangle |

### Color mapping

| Conclusion      | Foreground token |
|-----------------|------------------|
| success         | `success` (green) |
| failure         | `error` (red)    |
| in_progress     | `warning` (amber)|
| cancelled       | `dim`            |
| skipped         | `dim`            |
| timed_out       | `dim`            |
| action_required | `error`          |
| neutral         | `muted`          |
| stale           | `muted`          |
| queued/pending  | `muted`          |

### Selected row

```
│        Deploy          #41      main         push        failure  5m │
```
Selected row uses `bg("selectedBg")` with bold text. Chevron `\uF054` replaces the leading space. Timed/running rows also use selectable highlight when the Running Entry matches.

### Filter

`f` cycles through `["all", "my", "failed"]` — analog to the `/issues` filter.

| Filter   | Label               |
|----------|---------------------|
| all      | `All`               |
| my       | ` My` (nf-fa-user) |
| failed   | ` Failed`          |

---

## 2. Detail View — Failed Run with Multiple Jobs

Pressing Enter on run `#41 Deploy` opens:

```
┌─ : Deploy #41 ───────────────────────────────────────────────────────┐
│ main · push · failure · triggered by wj@gh · 5m ago                    │
├────────────────────────────────────────────────────────────────────────┤
│ Jobs (3/4 passed)                                                      │
│                                                                        │
│    build          1m 23s    success                                  │
│    test           4m 12s    success                                  │
│    deploy-prod     32s      failure   "ENOENT: .env.production"      │
│    notify          —        skipped   (depends on deploy-prod)       │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│   scroll  Enter steps  Ctrl+Enter open  r rerun  Esc back            │
└────────────────────────────────────────────────────────────────────────┘
```

### Top banner

```
│ : Deploy #41 ────────────────────────────────────────────────────────│
│ main · push · failure · triggered by wj@gh · 5m ago                    │
```

Single line of metadata separated by `·`:
- **branch** (head_branch)
- **event** (short form)
- **conclusion** (colored by conclusion)
- **actor** (`actor_login`) or `triggered by X`
- **relative time** from `updated_at` (or `created_at` for queued)

### Job list

Each job row: icon + name + duration + conclusion + (if failed, last error line).

| Column       | Width | Notes                                        |
|--------------|-------|-----------------------------------------------|
| Status icon  | 4     | Nerd Font icon + 1 space padding              |
| Job name     | 16    | Truncated with `…`                            |
| Duration     | 8     | `Xm Ys` or `—` for skipped                    |
| Conclusion   | 10    | Full conclusion string                        |
| Error hint   | rest  | Only for failed jobs: first line of error     |

### Drill-down to steps (future)

Pressing Enter on a job row → steps table (not in this design, but reserved). Steps view would show:

```
┌─ deploy-prod > Steps ──────────────────────────────────────────────────┐
│    Checkout               12s     success                            │
│    Install deps           2m 1s   success                            │
│    Build                  45s     success                            │
│    Deploy to production    8s     failure  "ENOENT: .env.production"  │
│    Smoke test              —      skipped                            │
├────────────────────────────────────────────────────────────────────────┤
│   scroll  Esc back                                                 │
└────────────────────────────────────────────────────────────────────────┘
```

**Not in v1 scope** — job list is the detail terminal. Steps drill-down is reserved for a follow-up.

---

## 3. Key Bindings

| Context    | Key          | Action                                        |
|------------|--------------|-----------------------------------------------|
| List       | ↑ ↓ / j k    | Navigate rows                                 |
| List       | Enter        | Open detail view for selected run             |
| List       | f            | Cycle filter: All → My → Failed → All        |
| List       | r            | Rerun selected workflow (POST re-run API)     |
| List       | Ctrl+Enter   | Open run URL in browser                       |
| List       | c            | Copy run URL to clipboard                     |
| List       | Home / End   | Jump to first/last row                        |
| List       | PgUp / PgDn  | Page through list                             |
| List       | Esc          | Close overlay                                 |
| Detail     | Esc          | Back to list view                             |
| Detail     | ↑ ↓ / PgUp/Dn| Scroll content                                |
| Detail     | Enter        | (reserved: steps drill-down on job)           |
| Detail     | r            | Rerun this workflow run                       |
| Detail     | Ctrl+Enter   | Open run URL in browser                       |

---

## 4. Data Flow

```
GitHub API (List workflow runs)
       │
       ▼
.dev/github/runs.json         ← GitHubActionsCache (up to 30 runs)
       │
       ▼
ActionsOverlay.render()       ← List view: one row per GitHubRun
       │
       │  [Enter on run]
       ▼
GitHub API (List jobs for run)
       │
       ▼
.dev/github/jobs/<run_id>.json  ← GitHubJobsDetail
       │
       ▼
renderDetailMode()            ← Detail view: one row per GitHubJob
```

### Cache freshness

- `runs.json` refreshed every 2 minutes (background sync) + on `/actions` open
- `jobs/<run_id>.json` fetched on Enter, cached for 5 minutes

---

## 5. Widget Integration

The existing widget gains a third counter group when GitHub is configured:

```
 5 todos    2 sentry    3 actions    6h 23m
```

Where the actions section shows:
- `` (nf-fa-github, `\uF09B`) icon in default foreground
- Count of non-success workflow runs (pending + in_progress + failure + action_required + cancelled + stale)
- Only shown when count > 0

When all actions are green (all success/skipped), the section collapses to a subtle:
```
 0
```
Or disappears entirely — TBD.

---

## 6. Error / Edge States

| State                | List view treatment                              |
|----------------------|--------------------------------------------------|
| No runs at all       | Empty state: `(no workflow runs found)` row       |
| All 30+ runs success | Normal list, footer says `Showing 30/142`         |
| API error            | Banner row: ` GitHub API error: rate limited`    |
| No GitHub remote     | `/actions` shows setup prompt (like Plane setup)  |
| No token             | Prompt for `~/.pi/agent/secrets/github.json`      |
| Run has no jobs      | Detail view: `(no job data for this run)`         |
