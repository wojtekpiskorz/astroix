---
'@wojciechpiskorz/astroix': patch
---

Refactor: one `/__astroix` mount with a method+path handler table (same-origin guard enforced once, structurally) and a dedicated routes module out of `content.ts` — dissolves the CC-25 `handleApiRequest` into small handlers (`handleEdit` 9, `dispatchApi` 7, `handleFile` 6; baseline entry dropped). Byte-identical behavior from the chrome (#80).
