---
'@wojciechpiskorz/astroix': patch
---

Fix live-refresh in the prebuilt chrome: `import.meta.hot` usage was dead-code-eliminated from the lib bundle, silently killing every push flow and the reload-shield announce (#166). Live refresh and reload protection now work identically from the installed package: client subscriptions moved to window CustomEvents and a hot→window translator rides the virtual chrome module in both delivery arms, carrying the node-side pushes to the chrome and the shield announce back to the dev server.
