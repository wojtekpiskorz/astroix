---
'@wojciechpiskorz/astroix': patch
---

Matcher core module (`src/core/matcher.ts`): given index payload records and a clicked canvas element, returns matching rules sorted by CSS specificity with the cascade winner marked (ties keep source order). Scoped rules match only via their effective selectors joined by the REST slice — the matcher never synthesizes cid forms, and scoped records without one (file not loaded on the route) never match. `@media` conditions pass through as badge data; selector-list specificity takes the most specific part; `:where` weighs zero and `:is`/`:not`/`:has` take their most specific argument.
