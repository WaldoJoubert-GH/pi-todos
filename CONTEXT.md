# Todos

Plane.so issue integration for pi — fetches, caches, and displays active (non-completed) issues as a TUI overlay and widget.

## Language

**Issue**:
A Plane.so work item with a unique ID, sequence number, title, description, state, and optional assignee.
_Avoid_: Ticket, task, item

**State**:
A Plane workspace-defined status label for an Issue (e.g., "In Progress", "Review", "Done"). Each State has a name, a hex color, and belongs to a State Group.
_Avoid_: Status

**State Group**:
A Plane system-level classification of States: `backlog`, `unstarted`, `started`, `completed`, `cancelled`, `triage`.
_Avoid_: State category, workflow stage

**State Hex**:
The per-State hex color defined in Plane (e.g., `#FF6B6B`). Used as an exact ANSI true-color foreground for TUI rendering. Fixed to Plane's branding — does not respond to theme changes.
_Avoid_: State color (ambiguous with theme tokens)

**Active**:
An Issue whose State belongs to any group other than `completed`. Backlog, unstarted, started, triage, and cancelled issues are all considered active.
_Avoid_: Open, pending, in-flight

**Widget**:
The always-visible status bar showing issue counts per State with their Plane colors.
_Avoid_: Status bar, pill bar

**Overlay**:
The interactive TUI layer opened by `/todos` with a list view and detail view.
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
