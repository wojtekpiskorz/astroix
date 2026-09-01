---
'@wojciechpiskorz/astroix': patch
---

Extracted the reusable editing domain into the `packages/core` workspace member (`@wojciechpiskorz/astroix-core`): collections, entry-writer, form-tree, indexer, matcher, route-resolver, and splice-writer moved with their tests, and the live integration keeps running through compatibility re-exports at `src/core/*` until the retirement gate (ADR-0010). TypeScript, Vitest discovery, coverage, CRAP analysis, baseline keys, and CI now cover the new location, with non-vacuous test discovery (missing or emptied packages/core discovery fails), and `scripts/crap.mjs` runs the coverage term bun-less via the repo-local vitest entry. No runtime behavior changed.
