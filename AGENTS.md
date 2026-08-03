# pi-todos

A pi extension that unifies Plane.so issues, Sentry errors, and Autotask time records under a shared `.dev/` directory with a TUI overlay. Written in TypeScript.

## Structure

```
extensions/
  index.ts          ← extension entry point (command handlers, widget, sync timers)
  src/
    types.ts        ← shared types and interfaces
    config.ts       ← setup, migration, dev config, secrets resolution
    plane.ts        ← Plane API client (sync, states, time entries)
    sentry.ts       ← Sentry API client (pull, detail fetch)
    autotask.ts     ← Autotask API client (time records, dashboard)
    tui.ts          ← TUI overlay components (UnifiedOverlay, TimesOverlay, widget)
    tools.ts        ← LLM tool registrations (get_todos, fetch_sentry_issue)
docs/
  adr/              ← architecture decision records
CONTEXT.md          ← domain language glossary (read it, don't duplicate it)
```

## Domain language

All domain terms live in [`CONTEXT.md`](CONTEXT.md) — Plane States, Sentry Issues, time tracking, widgets. Use those terms precisely; avoid the synonyms listed under each term's _Avoid_ line.

## Key decisions

- **Time entries are local-only** ([ADR 0001](docs/adr/0001-local-time-entries.md)). No sync to Plane — the timer must work without network.
- **Pi-managed updates** ([ADR 0002](docs/adr/0002-self-contained-version-check.md)). Installed via `@main` and updated through `pi update --extensions`. No custom version check.
- **Unified extension** ([ADR 0003](docs/adr/0003-unified-extension-with-sentry.md)). One extension, one `.dev/`, one `issues.json`, one overlay. `/todos` is a backward-compat alias for `/issues`.

## Dev

```bash
# Run locally without tagging
pi -e ./extensions/index.ts
```

- Secrets live in `~/.pi/agent/secrets/{plane,sentry,autotask}.json`.
- Per-project config in `.dev/config.json`.
- The `.dev/` directory is fully gitignored.
- Nerd Font is required for TUI icons — no Unicode fallback.

## Commands and tools

| Command | What it does |
|---|---|
| `/issues` / `/todos` | Open the unified overlay (Plane + Sentry issues) |
| `/pull-sentry <id>` | Fetch a Sentry issue by ID or URL |
| `/times` | Open the time dashboard (Autotask records + local time entries) |
| `get_todos` | LLM tool — reads `issues.json` |
| `fetch_sentry_issue` | LLM tool — pulls Sentry issue details |

## Widget

The always-visible status bar shows Plane issue counts per state (with Plane's colors), a Sentry count, Running Entry timer, daily total hours, and GitHub Actions CI status. Uses Nerd Font codepoints from the Private Use Area.

## Time tracking

- **Plane issues**: Stopwatch-based. Toggle with `s` in the overlay. Stored in `.dev/time-entries.json`. Only one Running Entry at a time.
- **Autotask**: Fetched from the Autotask REST API. Cached per-date in `.dev/autotask/<date>.json`. Synced every 5 minutes. Displayed in the `/times` dashboard alongside local entries.
