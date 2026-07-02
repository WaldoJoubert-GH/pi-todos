# pi-todos

Plane.so todo and Sentry issue integration for [pi](https://pi.dev) — lists your active Plane issues and pulled Sentry errors right inside the terminal.

## Install

```bash
pi install git:github.com/WaldoJoubert-GH/pi-todos@v1.2.3
```

## Setup

Run `/issues` in pi and follow the prompts. You'll need:

- A [Plane.so](https://plane.so) Personal Access Token (optional)
- Your workspace slug and project ID (optional)
- A [Sentry](https://sentry.io) Auth Token (optional)

You can configure either service independently — the extension works with zero, one, or both configured.

The extension stores your tokens globally at `~/.pi/agent/secrets/plane.json` and `~/.pi/agent/secrets/sentry.json`, and per-project config in `.dev/config.json`.

## Dev

Test locally without tagging:

```bash
pi -e ./extensions/index.ts
```

## What you get

- **`/issues`** — interactive TUI overlay listing all active Plane issues and pulled Sentry errors, with keyboard navigation, detail preview, browser open, and copy-to-clipboard. Filter by source with the `f` key.
- **`/todos`** — backward-compatible alias for `/issues`
- **`/pull-sentry <id>`** — fetch a Sentry issue by ID or URL, saved to `.dev/sentry/<id>.json` and added to the unified issues list
- **Issues widget** — always-visible status bar showing Plane issue counts by state + Sentry issue count
- **`get_todos` tool** — lets the LLM read your unified issue list (Plane + Sentry) when you ask about it
- **`fetch_sentry_issue` tool** — lets the LLM pull Sentry issue details directly
- **Background sync** — Plane cache refreshes every 5 minutes while pi is running
- **Time tracking** — toggle time entries on Plane issues with the `s` key in the overlay
