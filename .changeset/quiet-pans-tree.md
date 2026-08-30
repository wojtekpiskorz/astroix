---
'@wojciechpiskorz/astroix': patch
---

Content tree sidebar + unrouted-entry affordance (#111): the Content list renders entry ids as a collapsible folder tree (folders derived from id path segments, open by default, collapsed state in the content store so it survives tab roundtrips; flat ids stay bare, entries labeled by basename), and entries with zero candidate routes carry a dimmed marker with a "no route renders this entry" tooltip — presentation only, clicks behave exactly as before.
