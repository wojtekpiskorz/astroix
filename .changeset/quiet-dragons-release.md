---
"@wojciechpiskorz/astroix": patch
---

Stable release loop: the official `changesets/action` job on push to `main` (#59) — non-empty changeset queue → opens/updates the "Version Packages" PR; empty queue (version PR merged) → build, artifact + manifest gates, publish to `latest`, authenticated by the bypass-2FA `NPM_TOKEN` granular token (#48).
