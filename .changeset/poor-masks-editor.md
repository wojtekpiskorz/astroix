---
'@wojciechpiskorz/astroix': patch
---

CodeMirror 6 editor + write loop: clicking a rule opens a file editor pane (new `GET /__astroix/file` endpoint) scrolled to and highlighting the rule's range, with per-range chips jumping between the places one file styles the selection. Raw-text editing with a ~300 ms debounced auto-write — each pause diffs the document against the last-written snapshot (common prefix/suffix) and sends ONE contiguous edit through the splice endpoint, so everything outside the edit stays byte-identical; host HMR is the live preview and the payload refetches after every write. Playwright config moves to a single worker (specs share one dev server and edit fixture sources — determinism over wall-clock).
