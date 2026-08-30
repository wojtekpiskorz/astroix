---
"@wojciechpiskorz/astroix": patch
---

e2e: the loop spec's `__astroixLoopMarker` read gets its own wait budget (`expect.poll`) instead of an immediate read after the CSS assertion — the un-budgeted sample transiently missed under `retries: 0` (issue #135).
