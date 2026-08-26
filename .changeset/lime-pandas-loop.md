---
'@wojciechpiskorz/astroix': patch
---

Executable POC definition of done: `e2e/loop.spec.ts` runs the whole CSS editing loop in one deterministic test — default-on chrome → select mode → hover/click → rule list (hidden hash, ≥2 global, media badge, winner) → CodeMirror at the range → raw-text color edit → debounced write → byte-exact disk assertion → canvas reflection via HMR with a no-reload marker → `?builder=0` escape hatch. The owner's manual-smoke scenario lands as `docs/manual-smoke.md`, linked from the README as the human half of the DoD.
