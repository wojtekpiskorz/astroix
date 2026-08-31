---
'@wojciechpiskorz/astroix': patch
---

Restore source mode as a dedicated e2e lane (#150): src-ful staging (`.astroix-local-src` — dist copy + `src` symlink) consumed by a new `e2e/src-fixture` on port 4311, a source-mode spec pinning the new `data-astroix-chrome-mode` discriminator, fast-refresh, single-React and canvas, and tightened mode detection (src must sit beside the running dist — the old two-depth candidate leaked source mode into the dist-only main staging, so the main lane silently served chrome source instead of the prebuilt artifact since #123).
