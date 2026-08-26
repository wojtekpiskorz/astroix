---
'@wojciechpiskorz/astroix': patch
---

Splice-writer core module (`src/core/splice-writer.ts`): `spliceText` replaces a half-open character range with arbitrary text (bytes outside the range stay identical — no reprint), `appendRule` adds a rule at EOF with exactly one new line regardless of the file's trailing-newline convention. Invalid ranges throw a typed `SpliceRangeError` before any output is produced.
