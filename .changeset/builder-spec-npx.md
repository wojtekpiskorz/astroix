---
'@wojciechpiskorz/astroix': patch
---

Boot the fixture production build through the fixture's own `build` script (`npm run build`) instead of a hardcoded `bunx astro build`, so the zero-injection e2e runs wherever Bun is absent (#265): main's CI only provided bun through `oven-sh/setup-bun`, which the npm migration (#211) removes. Delegating to the fixture script also removes the runner-token failure class outright.
