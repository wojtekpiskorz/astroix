---
'@wojciechpiskorz/astroix': patch
---

Fix e2e pack lane late-write race: settle index.astro before the spec's bare restore (same family as #114), and heal planted pack-fixture dirt at boot behind ASTROIX_E2E_PACK_PORT — the quiet-settle is lifted from entry-restore.ts into a shared settle-writes.ts seam.
