---
'@wojciechpiskorz/astroix': patch
---

getStaticPaths-aware routes payload (#119): `rendering` + `renders` fields on `GET /__astroix/routes` (additive, background-enumerated — the endpoint never awaits the pass), a true unrouted-entry marker, render-aware navigation that stops landing clicks on 404 pages, `astroix:routes-changed` WS invalidation for the chrome's routes cache, and a vendored paginate shim pinned to core semantics.
