# How do we resolve owner/repo from CWD's git remote?

<!-- label: wayfinder:task -->

## Question

What's the robust algorithm for extracting `owner/repo` from the current working directory's git remote? Must handle:
- HTTPS URLs (`https://github.com/owner/repo.git`)
- SSH URLs (`git@github.com:owner/repo.git`)
- No remote configured (error UX)
- Multiple remotes (which one wins? `origin`? first alphabetically? prompt?)
- Detached repos / not a git repo (error UX)
- Non-GitHub remotes (error UX — this is GitHub Actions only)

Deliverable: a precise function spec (inputs, outputs, error cases) plus implementation in `extensions/src/github.ts`.
