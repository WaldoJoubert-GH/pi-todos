# Todos

Plane.so issue integration for pi — fetches, caches, and displays active (non-completed) issues as a TUI overlay and widget.

## Language

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
The per-State hex color defined in Plane (e.g., `#FF6B6B`). Used as an exact ANSI true-color foreground for TUI rendering. Fixed to Plane's branding — does not respond to theme changes.
_Avoid_: State color (ambiguous with theme tokens)

**Active**:
An Issue whose State belongs to any group other than `completed`. Backlog, unstarted, started, triage, and cancelled issues are all considered active.
_Avoid_: Open, pending, in-flight

**Slug-ID**:
A human-readable Issue identifier formed by joining the project identifier with the issue's sequence number, e.g. `PITODOS-1`. Unique within the workspace.
_Avoid_: Issue key, short code, ticket number

**Priority**:
A Plane issue priority level: `urgent`, `high`, `medium`, `low`, or `none`. Rendered as a color-coded label in the TUI: red for urgent, orange for high, yellow for medium, blue for low, gray for none.
_Avoid_: Severity, importance

**Widget**:
The always-visible status bar showing issue counts per State with their Plane colors, plus the Running Entry when one is active.
_Avoid_: Status bar, pill bar

**Time Entry**:
A record of time spent on a single Issue, consisting of a start timestamp and an optional stop timestamp. Only one Time Entry may be active (un-stopped) at a time across the workspace.
_Avoid_: Timer, clock, stopwatch, tracker

**Running Entry**:
The single Time Entry that is currently in progress — started but not yet stopped. Starting a new Running Entry automatically stops any existing one.
_Avoid_: Active timer, current timer, live session

**Time Entry Store**:
The local JSON file (`.todo/time-entries.json`) containing all Time Entries. Distinct from the Plane-synced cache — Time Entries are local-only and do not sync to Plane. The Running Entry survives pi restarts. If the timed Issue disappears from the Plane cache (completed or deleted), the Running Entry persists with a `⚠️` warning prefix until manually stopped.
_Avoid_: Time log, timesheet, timer file

**Elapsed**:
The live duration of a Running Entry, displayed in compact human form on the Widget: `Xh Ym Zs` with zero units dropped (e.g. `12m 34s`, `1h 5m`, `45s`). Updated every second.
_Avoid_: Duration (ambiguous — could mean a stored, fixed duration of a stopped entry)

**Accumulated Time**:
The total time spent on an Issue — the sum of all stopped Time Entry durations plus the current Elapsed if it's the Running Entry. Displayed in the detail view meta line as `Total: Xh Ym Zs`.
_Avoid_: Total time, tracked time, logged time

**Overlay**:
The interactive TUI layer opened by `/todos` with a list view and detail view. `s` toggles a Time Entry on the highlighted Issue (or the detail Issue when in detail view). The timed issue shows a `⏱` indicator in the list. The detail meta line shows accumulated time (`Total: Xh Ym Zs`) summing all stopped Time Entries for the issue plus the current Elapsed if running.
_Avoid_: Popup, modal (it's an overlay in pi's component model)

## Example dialogue

> **Dev**: When I open `/todos`, I see "In Progress" and "Review" in the list — both are `started` group. Should they have the same color?
>
> **Domain expert**: No — each State has its own hex color in Plane. "In Progress" might be orange, "Review" might be blue. The TUI should show those exact colors, not group-level colors.
>
> **Dev**: So the widget pills should break down by State, not by group?
>
> **Domain expert**: Exactly. Group determines the sort order, but each pill is a State with its own count and color.
>
> **Dev**: What if a State has no color set in Plane?
>
> **Domain expert**: Fall back to neutral gray.
>
> **Dev**: How do I reference an issue when talking to a colleague?
>
> **Domain expert**: Use the Slug-ID, like `PITODOS-1`. It's globally unique within the workspace and copyable with `c` in the overlay.
>
> **Dev**: What if the project identifier hasn't been fetched yet?
>
> **Domain expert**: Fall back to the bare sequence number like `#1` until the identifier arrives.
>
> **Dev**: I started timing PITODOS-3, then accidentally pressed `s` on PITODOS-5. What happened to the entry for PITODOS-3?
>
> **Domain expert**: It was automatically stopped. Only one Running Entry can exist at a time. PITODOS-3's Time Entry now has a stop timestamp and PITODOS-5 is the new Running Entry.
>
> **Dev**: So if I press `s` on PITODOS-5 again, it stops?
>
> **Domain expert**: Yes. Press `s` on the Running Entry to stop it, or on any other Issue to switch. Toggle semantics — same key, context-dependent behavior.
>
> **Dev**: I closed pi while timing PITODOS-3. When I reopen, does the timer reset?
>
> **Domain expert**: No — the Running Entry survives restarts. The Elapsed will include the time pi was closed, since the start timestamp is preserved in the Time Entry Store.
