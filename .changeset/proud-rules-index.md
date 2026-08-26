---
'@wojciechpiskorz/astroix': patch
---

Indexer core module (`src/core/indexer.ts`): scans project CSS sources (global `.css` + `.astro` style blocks) into the edit-truth index — per rule: verbatim source-space selector, file, character range, `@media` condition, scoped flag, and the module-graph style-block index (`null` for `is:inline`, which the compiler never extracts but the edit-truth scan sees).
