# pi-todos

Plane.so todo, Sentry issue, and Autotask time integration for [pi](https://pi.dev) — issues list, time tracking, and a unified TUI overlay, all inside the terminal.

## Install

```bash
pi install git:github.com/WaldoJoubert-GH/pi-todos@main
```

Updates via pi's built-in package management:

```bash
pi update --extensions
```

## What you get

### Commands

| Command | Description |
|---|---|
| `/issues` | Interactive TUI overlay — all active Plane issues + pulled Sentry errors. Keyboard navigation, detail preview, browser open, copy-to-clipboard. Filter by source with `f`. |
| `/todos` | Backward-compatible alias for `/issues` |
| `/pull-sentry <id>` | Fetch a Sentry issue by ID or URL. Saved to `.dev/sentry/<id>.json` and added to the unified list. |
| `/times` | Time dashboard — unified chronological view of Autotask time records and local Plane time entries for the day, with day navigation and total hours. |

### Widget

Always-visible status bar showing Plane issue counts per state (in Plane's colors), Sentry count, Running Entry timer, daily total hours, and GitHub Actions CI status. Uses Nerd Font icons.

### LLM tools

- **`get_todos`** — reads the unified issue list (Plane + Sentry) so the agent can answer "what's on my list?"
- **`fetch_sentry_issue`** — pulls Sentry issue details on demand

### Time tracking

- **Plane issues**: Stopwatch-based. Toggle with `s` in the overlay. Local-only — no sync to Plane. One Running Entry at a time, surviving pi restarts.
- **Autotask**: Fetched from the Autotask REST API, cached per-date, synced every 5 minutes. Billable/non-billable with visual distinction.

## Setup

Run any command (`/issues`, `/times`) in pi and follow the interactive prompts. Each service is independently configurable — use zero, one, two, or all three.

| Service | What you need | Secrets stored at |
|---|---|---|
| Plane | Personal Access Token, workspace slug, project ID | `~/.pi/agent/secrets/plane.json` |
| Sentry | Auth Token, org slug, project slug | `~/.pi/agent/secrets/sentry.json` |
| Autotask | API Integration Code, username, secret, resource ID | `~/.pi/agent/secrets/autotask.json` |

Per-project config lives in `.dev/config.json`. Background sync runs every 5 minutes.

## Requirements

- **Nerd Font** (e.g. FiraCode Nerd Font) — required for TUI icons. No Unicode fallback.

## Dev

```bash
pi -e ./extensions/index.ts
```

See [`AGENTS.md`](AGENTS.md) for project structure, domain language, and architecture decisions.
