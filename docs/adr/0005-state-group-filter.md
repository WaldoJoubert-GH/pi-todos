# Two-axis TUI filtering: source × state group

The `/issues` overlay needs a second filter dimension — state group — navigated with `←`/`→`, alongside the existing source filter (`f`).

## Decision

Two orthogonal filters compose:

| Filter | Keys | Options |
|---|---|---|
| Source | `f` | `all`, `plane`, `sentry` |
| State group | `←`/`→` | `All` (active), `backlog`, `unstarted`, `started`, `triage`, `completed`, `cancelled` |

Composition rules:
- **Sentry issues always pass the state-group filter** — they have no `state_group` field and ignore it.
- **Plane issues are filtered by the selected state group**, except `All` which means all *active* groups (`backlog`, `unstarted`, `started`, `triage`).
- The source filter layers on top — `sentry` source hides all Plane issues regardless of state-group.

Cycle order wraps: `All → backlog → unstarted → started → triage → completed → cancelled → All...`

Title bar shows both: `Issues (N) [ Plane · started]` — source icon/label first, then state group separated by a middle dot.

Widget is unchanged — it continues to show active-only per-State pill counts regardless of overlay filter state.

## Why

Previously `completed` and `cancelled` issues were excluded at sync time (`EXCLUDED_GROUPS`). They never entered the issues list. Users had no way to view completed work in the TUI.

By moving exclusion from sync-time to filter-time, all issues live in `issues.json` and the default `All` filter preserves the active-only view. The dedicated group filters give access to completed/cancelled issues without cluttering the default view.

## Trade-offs

- **Sync pulls more issues** — `completed`/`cancelled` items are now fetched and cached. For busy projects this could significantly increase the payload. Mitigated by the fact that these are already in the Plane API response; we were just discarding them.
- **Two-axis filter can be disorienting** — the user must track two filter states. Mitigated by the title bar showing both explicitly and the fact that Sentry always passes the state-group filter (no hidden filtering).
- **Sentry ignoring state-group is asymmetric** — some users might expect "started" to show nothing from Sentry. This is intentional: Sentry has no equivalent concept, and hiding Sentry issues would make them silently disappear when cycling groups, which is worse UX.

## Considered alternatives

- **Collapse state groups into buckets** (e.g., "Todo" = backlog + unstarted, "Done" = completed + cancelled). Rejected — it introduces a second set of labels that aren't Plane-native and would need mapping logic. Using Plane's state groups directly is simpler and more transparent.
- **Replace source filter with state-group filter** — rejected because the source filter (plane/sentry/all) is independently useful and they don't conflict.
- **Single unified cycle that includes both** — rejected because it would explode the number of options (3 sources × 7 groups = 21 entries) and lose the ability to independently toggle each dimension.
