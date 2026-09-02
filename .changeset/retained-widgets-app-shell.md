---
'@wojciechpiskorz/astroix': patch
---

Extract the retained prop-driven presentation widgets into the app-shell package (C2). The CSS rule list/index status, the content form widget set, the entry tree, the shell header, the editor header/range chips, the pane states, and the write-status badge move to `packages/app-shell/src/presentation/` behind typed props derived from the frozen B1/B2 behavior contracts (new `./presentation` export surface; the domain-deaf barrel gains nothing). The integration chrome keeps its stores, fetch, and runtime wiring and renders the moved widgets through compatibility adapters until the retirement gate.
