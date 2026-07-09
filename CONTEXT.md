# Dev Hub

Plane.so todo and Sentry issue integration for pi — unified under a shared `.dev/` directory with a common `issues.json` list file and a single `/issues` TUI overlay.

## Language

### Plane

**Issue**:
A Plane.so work item with a unique ID, sequence number, title, description, state, and priority.
_Avoid_: Ticket, task, item

**State**:
A Plane workspace-defined status label for an Issue (e.g., "In Progress", "Review", "Done"). Each State has a name, a hex color, and belongs to a State Group.
_Avoid_: Status

**State Group**:
A Plane system-level classification of States: `backlog`, `unstarted`, `started`, `completed`, `cancelled`, `triage`.
_Avoid_: State category, workflow stage

**State Abbreviation**:
A compact rendering of a State name for the widget, formed by taking the first character of each whitespace-delimited word and uppercasing. E.g., `"TO Update Production"` → `"TUP"`, `"In Progress"` → `"IP"`. Used only on the widget pill bar; all other surfaces use the full State name.
_Avoid_: Short name, acronym (it's a mechanical derivation, not a human-chosen label)

**State Hex**:
The per-State hex color defined in Plane (e.g., `#FF6B6B`). Used as a filled background pill with auto-contrasting text — black on light hexes, white on dark hexes. Fixed to Plane's branding — does not respond to theme changes.
_Avoid_: State color (ambiguous with theme tokens)

**State Pill**:
The visual rendering of a State as a background-filled, padded label. The fill color is the State Hex; the text color is auto-selected (black or white) based on the hex's relative luminance. Each side of the label has a single-space padding. Used on the widget, overlay list, and overlay detail view.
_Avoid_: State badge, state chip, state tag

**State ID**:
The Plane-internal UUID for a State (e.g., `b2f3a1c4-...`). Needed when calling the Plane API to mutate an Issue's State. Stored on the UnifiedIssue as `state_id` and in the State Cache File alongside the display name, hex, and group.
_Avoid_: State key, state uuid (one word, canonical form is "State ID")

**State Cache File**:
A local JSON file at `.dev/plane-states.json` holding the full list of States for the configured Plane workspace: each with its State ID, name, hex color, and group. Written on every Plane sync (5-minute background + on-demand). Read by the overlay to populate the State dropdown.
_Avoid_: States file, state list cache

**State Dropdown**:
The popup modal in the overlay triggered by `d` that lists all workspace States as State Pills for selection. Arrow keys navigate, Enter confirms a State change, Escape cancels.
_Avoid_: Status picker, state selector

**Active**:
An Issue whose State belongs to any group other than `completed` or `cancelled`. Backlog, unstarted, started, and triage issues are considered active.
_Avoid_: Open, pending, in-flight

**Slug-ID**:
A human-readable Issue identifier formed by joining the project identifier with the issue's sequence number, e.g. `PITODOS-1`. Unique within the workspace.
_Avoid_: Issue key, short code, ticket number

**Priority**:
A Plane issue priority level: `urgent`, `high`, `medium`, `low`, or `none`. Rendered as a color-coded label in the TUI: red for urgent, orange for high, yellow for medium, blue for low, gray for none.
_Avoid_: Severity, importance

**Widget**:
The always-visible status bar showing issue counts per State with their Plane colors, the Daily Total, and the Running Entry when one is active. Uses Nerd Font icons: `` (nf-fa-tasks) for Plane count, `` (nf-fa-bug) for Sentry count, `` (nf-fa-clock-o) for Daily Total, `` (nf-fa-check_circle) for zero-state, `` (nf-fa-exclamation_triangle) for sync errors, `` (nf-fa-clock_o) for the Running Entry timer, and `` (nf-fa-download) for update notifications.
_Avoid_: Status bar, pill bar

**Time Entry**:
A record of time spent on a single Plane Issue, consisting of a start timestamp and an optional stop timestamp. Only one Time Entry may be active (un-stopped) at a time across the workspace. Does not apply to Sentry Issues.
_Avoid_: Timer, clock, stopwatch, tracker

**Running Entry**:
The single Time Entry that is currently in progress — started but not yet stopped. Starting a new Running Entry automatically stops any existing one.
_Avoid_: Active timer, current timer, live session

**Time Entry Store**:
The local JSON file (`.dev/time-entries.json`) containing all Time Entries. Distinct from the Plane-synced cache — Time Entries are local-only and do not sync to Plane. The Running Entry survives pi restarts. If the timed Issue disappears from the issues list (completed or deleted), the Running Entry persists with a warning prefix until manually stopped.
_Avoid_: Time log, timesheet, timer file

**Elapsed**:
The live duration of a Running Entry, displayed in compact human form on the Widget: `Xh Ym Zs` with zero units dropped (e.g. `12m 34s`, `1h 5m`, `45s`). Updated every second.
_Avoid_: Duration (ambiguous — could mean a stored, fixed duration of a stopped entry)

**Accumulated Time**:
The total time spent on a Plane Issue — the sum of all stopped Time Entry durations plus the current Elapsed if it's the Running Entry. Not applicable to Sentry Issues.
_Avoid_: Total time, tracked time, logged time

**Daily Total**:
The combined time from local Time Entries and Autotask Time Records for the current day (using the UTC offset for date-boundary, falling back to UTC+0 when Autotask is not configured). Displayed on the widget as `Xh Ym` (hours + minutes, no seconds) with a `` (nf-fa-clock-o) icon. Shown always, even when zero or when there are no active issues.
_Avoid_: Day total, daily hours

**Overlay**:
The interactive TUI layer opened by `/issues` (or `/todos` as an alias) with a unified list view and detail view. `s` toggles a Time Entry on the highlighted Plane Issue. The timed issue and selected row show a `` (nf-fa-chevron_right) cursor. `f` toggles the filter between all, plane-only, and sentry-only views.
_Avoid_: Popup, modal

**Nerd Font**:
All TUI icons use Nerd Font (FiraCode Nerd Font) codepoints from the Private Use Area. There is no fallback to vanilla Unicode — a Nerd Font-patched monospace font is required. Icons used include `` (nf-fa-tasks for Plane items), `` (nf-fa-bug for Sentry items), `` (nf-fa-exclamation_triangle for warnings), `` (nf-fa-clock_o for Running Entry timer), `` (nf-fa-clock-o for Daily Total), `` (nf-fa-download for updates), `` (nf-fa-check_circle for zero-state), `` (nf-fa-edit), `` (nf-fa-list_ol), `` (nf-fa-history), `` (nf-fa-exchange), and `` `` `` (chevron/angle navigation arrows).
_Avoid_: Unicode icons, ASCII fallback

**Create**:
The action of adding a new Plane Issue directly from the `/issues` overlay by pressing `n`, typing a title, and pressing Enter. Issues are created via the Plane REST API. The verb used for the user action, not the system operation.
_Avoid_: Add, make, post, submit

**New Issue**:
The noun phrase for the object being created in the inline input mode. Displayed as the title of the input modal ("New Issue") and used in UI labels. Refers to the state before the Issue exists — once created it becomes a regular Plane Issue.
_Avoid_: New todo, new ticket, new item

**Create-issue Input Mode**:
The inline text input state entered by pressing `n` in the overlay (from either list or detail view). Printable characters populate the input buffer, Backspace deletes, Enter submits (non-empty buffer), and Escape cancels. Empty titles are treated the same as Escape.
_Avoid_: Input mode, title input, new issue prompt

### Sentry

**Sentry Issue**:
A Sentry error/exception group identified by a numeric ID, with a title, level, status, first/last seen timestamps, event count, culprit, and permalink. Pulled on demand via `/pull-sentry <id>`.
_Avoid_: Error, exception, crash

**Level**:
Sentry severity classification: `fatal`, `error`, `warning`, `info`, `debug`. Rendered as a color-coded label in the overlay.
_Avoid_: Severity, log level

**Sentry Status**:
Sentry resolution state: `unresolved`, `resolved`, `ignored`. Displayed in the unified overlay list and detail views.
_Avoid_: State (reserved for Plane)

**Pull**:
The act of fetching a Sentry Issue from the Sentry API and saving it locally. A Pull writes two things: a summary entry in `issues.json` and a full detail file in `.dev/sentry/<id>.json`. Pulls are manual — there is no automatic Sentry sync.
_Avoid_: Fetch, download, import

**Sentry Detail File**:
A JSON file at `.dev/sentry/<id>.json` containing the full Sentry issue payload: stack trace, breadcrumbs, tags, request context, and exception data. Referenced by the summary entry in `issues.json` via `detail_file`. Too large to inline.
_Avoid_: Full payload, raw issue

### Autotask

**Autotask Time Record**:
A single time entry fetched from the Autotask API — has an Autotask `id`, `ticketID`, `startDateTime` / `endDateTime`, `hoursWorked`, `hoursToBill`, `summaryNotes`, and `isNonBillable`. Cached per-date in `.dev/autotask/<date>.json`. Distinct from the local Time Entry (which is stopwatch-based and keyed to a Plane issue).
_Avoid_: Autotask entry, external time entry, timesheet row

**Time Dashboard**:
What the `/times` command renders — a unified chronological list of Autotask Time Records and local Time Entries for a given day, color-coded by source. Local entries render in cyan; Autotask entries in default foreground. Non-billable Autotask entries are dimmed. A Running Entry (un-stopped local) gets an active indicator. Navigable by day with `←`/`→` and `t` to return to today. Shows a footer with total hours summed across both sources.
_Avoid_: Timesheet view, time list, day view

**Autotask Config**:
The four connection values for the Autotask REST API: API Integration Code, Username, and Secret live in `~/.pi/agent/secrets/autotask.json`. Resource ID and API Base URL live in `.dev/config.json` under the `autotask` key. The API Base URL defaults to `https://webservices16.autotask.net` and only needs to be set if the tenant moves to a different endpoint.
_Avoid_: Autotask settings, PSA config

**Autotask Cache**:
A per-date JSON file at `.dev/autotask/<YYYY-MM-DD>.json` holding the raw Autotask API response for that date. Written on `/times` invocation and on the background 5-minute sync. The overlay reads from the current day's cache, falling back to a live API fetch.
_Avoid_: Time entries file (reserved for `.dev/time-entries.json`), autotask dump

**Autotask Setup Flow**:
On first `/times` invocation when no Autotask Config exists, the user is interactively prompted for: API Integration Code, Username, Secret (saved to secrets file), and Resource ID (saved to dev config). Non-interactive mode prints setup instructions listing the required files and their JSON format — matching the Plane setup pattern.
_Avoid_: Onboarding, first-run wizard

**Non-Billable**:
An Autotask Time Record where `isNonBillable` is `true`. Rendered in dim/gray text throughout the Time Dashboard to visually de-emphasise.
_Avoid_: Unbillable, internal time

**Billable**:
An Autotask Time Record where `isNonBillable` is `false`. Rendered in normal-weight default foreground. Optionally prefixed with a `` (nf-fa-dollar) Nerd Font glyph for quick visual scan.
_Avoid_: Chargeable, client time

### Shared

**Dev Directory** (`.dev/`):
The shared data directory for this extension's local files: config, issues list, time entries, and sentry detail files. Gitignored entirely.
_Avoid_: Data dir, cache dir, .pi-data

**Dev Config** (`.dev/config.json`):
A namespaced JSON file with `plane`, `sentry`, and `autotask` sections, each containing the connection details for that service. A user can configure zero, one, two, or all three services.
_Avoid_: Settings, project config (ambiguous)

**Issues File** (`issues.json`):
The unified list of all tracked items — Plane Issues and pulled Sentry Issues — with a `source` discriminator. Plane entries are rewritten on each sync; Sentry entries are appended/updated on each Pull. The TUI overlay reads exclusively from this file.
_Avoid_: Cache, todo list, issue index
