---
"@wojciechpiskorz/astroix": patch
---

Stable release loop: the official `changesets/action` job on push to `main` (sketch #1 in `research/release-channels.md` on branch `research/release-channels`). Non-empty changeset queue → opens/updates the "Version Packages" PR; empty queue (version PR merged) → `bun run build && changeset publish` to `latest`. Goes live once the owner enables "Allow GitHub Actions to create and approve pull requests" and confirms `NPM_TOKEN` is the bypass-2FA granular token from #48.
