---
'@wojciechpiskorz/astroix': patch
---

Shape-aware self-heal for the local-link fixture boot: `scripts/prepare-local-link.mjs` now extracts a non-throwing `isPublishShaped` predicate and re-installs the fixture's `file:` dep when the installed copy stops being publish-shaped (pre-#123 full-repo residue), not only on a dist digest mismatch — a regressed copy self-heals on the next boot instead of bricking it. Verified: a frozen dir-`file:` install evicts foreign dirs/files wholesale, so no explicit removal is needed (unlike the tarball lane).
