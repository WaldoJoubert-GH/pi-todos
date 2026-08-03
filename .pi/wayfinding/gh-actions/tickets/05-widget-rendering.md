# How should the widget render the latest-run status?

<!-- label: wayfinder:prototype -->
<!-- blocked-by: 04-nerd-font-icons.md -->

## Question

Design the widget pill for the latest workflow run status. Must handle all states:
- **Normal**: icon + relative time (e.g., " 41 min ago" for success, " 12 min ago" for failure). If running, show elapsed instead (e.g., " 3m 21s").
- **No runs yet**: a distinct zero-state (like `` for no issues).
- **Auth failure / no token**: error indicator.
- **API error / rate limited**: warning state distinct from auth failure.
- **Not a git repo**: graceful no-op (don't render the pill at all).

How does this pill sit visually alongside the existing Plane state pills and the Sentry count? Does it get its own icon prefix or blend with the existing layout? Does the pill have a color (green for pass, red for fail, yellow for running)?

Deliverable: a mock rendered widget line showing all pills together (Plane states + Sentry count + Actions status + Daily Total + Running Entry).
