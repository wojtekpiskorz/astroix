---
'@wojciechpiskorz/astroix': patch
---

Start the no-E2E interval early (owner ruling on #197): delete the legacy-chrome regression e2e suite (17 specs + helpers + stall-lab) and the three webServer lanes; keep the plain fixture, the disposable-oracle capture substrate, and one serverless plain-fixture build smoke as the interval's only e2e (#282, supersedes #281).
