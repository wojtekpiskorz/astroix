---
'@wojciechpiskorz/astroix': patch
---

Rule list panel: on selection, the chrome runs the matcher over the index payload against the canvas element and renders matched rules — source-space selectors (cid hashes never displayed), file and one-based source line (derived in the indexer from the rule range), specificity-sorted with the cascade winner marked, `@media` condition badges (unevaluated), and a multi-place hint when one file styles the element in ≥2 places. Explicit empty state; the payload refetches on selection (the module-graph join can race the canvas page load).
