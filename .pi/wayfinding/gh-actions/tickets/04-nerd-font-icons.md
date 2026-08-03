# What Nerd Font icons for each run/job status?

<!-- label: wayfinder:prototype -->
<!-- blocked-by: 03-data-model.md -->
<!-- status: closed -->

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

## Resolution

Prototype delivered — [ADR 0004: GitHub Actions Status Icons](../../../docs/adr/0004-github-actions-icons.md) + visual test at [`extensions/test/github-status-icons.ts`](../../../extensions/test/github-status-icons.ts).

7 icons chosen from FA 4.7 set (zero collisions with existing 15 widget icons):

| Status | Icon | Codepoint |
|--------|------|-----------|
| queued |  hourglass_o | U+F250 |
| in_progress |  circle_o_notch | U+F1CE |
| success |  check | U+F00C |
| failure |  times | U+F00D |
| cancelled |  minus_circle | U+F056 |
| skipped |  fast_forward | U+F050 |
| timed_out |  hourglass_3 | U+F253 |

⚠️ **Note:** The parallel widget and overlay prototypes chose slightly different icons for some statuses (e.g., success =  check_circle vs  check). Reconciliation needed — the human picks the final mapping.
