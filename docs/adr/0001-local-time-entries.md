# Time Entries are local-only, not synced to Plane

Plane.so has a built-in time tracking API, but we chose to store Time Entries entirely in a local `.todo/time-entries.json` file. The alternative was to use Plane's API to create/read time entries, keeping them visible in the Plane web UI and synced across machines.

**Why local?** The feature is primarily about real-time UX — a visible timer on the widget, per-second updates, toggle via `s` in the overlay. Plane's time tracking API would add latency, auth concerns, and complexity (per-entry API calls on every start/stop) for no immediate gain. The widget and overlay already work entirely from local cache; adding network dependency to the timer would make it less reliable.

**Can we change our mind?** Yes. The local store is a simple JSON file. If we later want to sync, we can batch-upload existing entries to Plane and swap the store for the API.

**Considered alternative**: Use Plane's time tracking API as the primary store. Rejected because it would make the per-second widget refresh dependent on network state and introduce failure modes (API down = timer broken).
