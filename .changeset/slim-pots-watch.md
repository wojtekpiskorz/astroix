---
'@wojciechpiskorz/astroix': patch
---

Move the 16 client-only dependencies (CodeMirror, TanStack, Base UI, lucide, yaml, …) to `devDependencies` — the published manifest now declares only the 4 node-side runtime externals, and a `check:dist-graph` CI gate keeps `dist/` bare imports inside builtins + `dependencies` + peers.
