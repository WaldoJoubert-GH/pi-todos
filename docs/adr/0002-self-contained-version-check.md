# Extension checks its own version, not pi core

pi-todos detects new releases by running `git ls-remote --tags` against its own repository on every `session_start`. The alternative was to wait for pi to add native git-package update discovery in `pi update`.

**Why self-contained?** pi's current `pi update` only reconciles existing pinned refs — it doesn't check for newer tags. Adding update discovery to pi core requires a feature request, design discussion, and release cycle across all pi users. Self-containment ships immediately with zero pi changes.

**Can we change our mind?** Yes. The version-check is ~40 lines, gated behind a single `session_start` handler. If pi later adds native `pi update --check`, we rip out the check and let pi handle it. The feature is additive, not architectural.
