# pi-todos

Plane.so todo list integration for [pi](https://pi.dev) — lists your active Plane issues right inside the terminal.

## Install

```bash
pi install git:github.com/WaldoJoubert-GH/pi-todos@v1.0.0
```

## Setup

Run `/todos` in pi and follow the prompts. You'll need:

- A [Plane.so](https://plane.so) Personal Access Token
- Your workspace slug and project ID

The extension stores your token globally at `~/.pi/agent/secrets/plane.json` and per-project config in `.todo/config.json`.

## Dev

Test locally without tagging:

```bash
pi -e ./extensions/todos.ts
```

## What you get

- **`/todos`** — interactive TUI overlay listing all active (non-completed) issues, with keyboard navigation, detail preview, browser open, and copy-to-clipboard
- **Todos widget** — always-visible status bar showing issue counts by state group
- **`get_todos` tool** — lets the LLM read your todo list when you ask about it
- **Background sync** — cache refreshes every 5 minutes while pi is running
