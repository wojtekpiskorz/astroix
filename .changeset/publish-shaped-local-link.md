---
'@wojciechpiskorz/astroix': patch
---

Publish-shaped local link for the e2e fixture (#123): `scripts/prepare-local-link.mjs` (wired into the fixture dev script and `bun run prepare-local`) rebuilds `dist` when stale, syncs only the publish surface (`dist`, `package.json`, `README`, `LICENSE`) into the gitignored `.astroix-local/` staging dir, refreshes the fixture's installed copy, and guards that the copy never regresses to a full-repo shape (no `src/`/`e2e/` inside). The fixture dependency moves from `file:../..` to `file:../../.astroix-local`, killing the recursive `node_modules` nesting (10 levels, 316M) that `file:`-linking the repo root produced; CI stages the link before the fixture's frozen install.
