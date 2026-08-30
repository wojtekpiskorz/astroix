---
'@wojciechpiskorz/astroix': patch
---

Chrome collections list live-refresh on external content edits (#133): an astroix-owned `astroix:content-synced` WS push rides the client hot channel (astro's own content event only ever fires on the ssr channel, so the chrome never heard it) — scheduled from the shared content-signal classification (`src/node/content-signal.ts`, the same predicate that re-arms the #119 enumeration) and the loader's post-commit data-store write, deferred by a render grace so the chrome's refetch never races the canvas's post-commit full-reload render; the chrome invalidates COLLECTIONS_KEY + SCHEMA_KEY on receipt.
