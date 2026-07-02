# Merge Sentry into pi-todos as a unified extension sharing .dev/

Previously, `sentry.ts` was a standalone extension with its own `.sentry/` directory and config, and `extensions/todos.ts` used `.todo/`. They had no shared infrastructure despite both being "things to track." We merged them into a single extension sharing `.dev/` for all data, with a unified `issues.json` list file and a unified TUI overlay under `/issues` (with `/todos` as a backward-compat alias).

**Why merge?** Two extensions reading/writing separate hidden directories in the same project felt like two tools doing one job. A unified overlay lets you see Plane todos and Sentry bugs side by side. Shared config means one setup step. Shared `.dev/` means one `.gitignore` and one mental model.

**Considered alternative**: Keep them separate with a shared lib. Rejected because it still means two extension entry points, two startup handlers, and coordination complexity around the shared directory writes.

**Considered alternative**: Name the directory `.issues/`. Rejected — too narrow. The directory may grow to hold non-issue data (traces, metrics, etc.). `.dev/` is a catch-all for extension scratch data.
