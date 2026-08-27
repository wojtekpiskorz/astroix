---
'@wojciechpiskorz/astroix': patch
---

Environment separation between the owner's smoke and the bot e2e lanes: the main e2e lane moves to `:4314` (fixture dev script parametrized via `ASTROIX_E2E_PORT`, default `4312` stays the owner's smoke port), both Playwright lanes set `reuseExistingServer: false` (no zombie adoption), and `bun run smoke` fails fast with an actionable message when `:4312` is already occupied instead of letting astro fail cryptically.
