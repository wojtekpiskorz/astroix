---
'@wojciechpiskorz/astroix': patch
---

Boot the fixture production build via `npx astro build` instead of `bunx` so the dev-only-guarantee e2e runs where Bun is absent (#265): main's CI only provided bun through `oven-sh/setup-bun`, which the npm migration (#211) removes.
