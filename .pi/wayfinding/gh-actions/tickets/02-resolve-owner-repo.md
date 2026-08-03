# How do we resolve owner/repo from CWD's git remote?

<!-- label: wayfinder:task -->
<!-- assignee: agent -->
<!-- status: closed -->

## Question

What's the robust algorithm for extracting `owner/repo` from the current working directory's git remote? Must handle:
- HTTPS URLs (`https://github.com/owner/repo.git`)
- SSH URLs (`git@github.com:owner/repo.git`)
- No remote configured (error UX)
- Multiple remotes (which one wins? `origin`? first alphabetically? prompt?)
- Detached repos / not a git repo (error UX)
- Non-GitHub remotes (error UX — this is GitHub Actions only)

Deliverable: a precise function spec (inputs, outputs, error cases) plus implementation in `extensions/src/github.ts`.

## Resolution

Implemented `resolveGitHubRepo()` in [`extensions/src/github.ts`](../../../extensions/src/github.ts#L39-L72).

**Algorithm:**
1. `git remote get-url origin` → prefer origin
2. If no origin: list all remotes (`git remote`), iterate alphabetically, first GitHub URL wins
3. If zero remotes or not a git repo: error with `no_github_remote` / `not_a_git_repo`
4. Parse URL: supports HTTPS (`https://github.com/owner/repo.git`), SSH (`git@github.com:owner/repo.git`), and `ssh://` protocol variants
5. Validate host is `github.com` — non-GitHub remotes return `not_a_github_repo`

Also added:
- `loadGitHubToken()` / `saveGitHubToken()` — token in `~/.pi/agent/secrets/github.json`
- `formatRelativeTime()` — "41 min ago" style for widget
- `formatElapsed()` — "3m 21s" elapsed for running runs
