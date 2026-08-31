---
'@wojciechpiskorz/astroix': patch
---

Fix live-refresh in the prebuilt chrome: `import.meta.hot` usage was dead-code-eliminated from the lib bundle, silently killing every push flow and the reload-shield announce (#166). Client subscriptions (`astroix:file-changed`, `astroix:content-synced`, `astroix:routes-changed`) moved to window CustomEvents, and a hot→window translator is prepended to the virtual chrome module in both delivery arms — it also carries the chrome's `astroix:chrome` announce to the node-side reload shield in prebuilt mode. One code path, identical semantics in source and prebuilt modes; new pack-lane specs pin the external-edit live-refresh and the shield arming against the shipped artifact.
