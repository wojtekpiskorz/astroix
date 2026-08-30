---
'@wojciechpiskorz/astroix': patch
---

Per-lane e2e ports (#120): both Playwright webServers (main fixture, npm-pack lane) read their ports from `ASTROIX_E2E_PORT` / `ASTROIX_E2E_PACK_PORT`, keeping 4314/4313 as canonical CI defaults — parallel local lanes no longer race for, or adopt, a sibling lane's dev server. The pack spec takes its base URL from the shared ports module instead of a hardcoded `:4313`.
