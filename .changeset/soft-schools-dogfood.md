---
'@wojciechpiskorz/astroix': patch
---

Dogfood wiring: the e2e fixture consumes the local package via `file:../..` and registers `astroix()` in its `astro.config.mjs`; CI builds the package before the Playwright e2e job.
