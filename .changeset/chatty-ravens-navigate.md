---
'@wojciechpiskorz/astroix': patch
---

feat: content list, reactive selection, entry→canvas navigation (#71)

The Content sidebar becomes the collections→entries list with the active entry highlighted. Active entry is set manually (list click — the form opens first) or reactively: every canvas iframe `load` resolves the URL through the core route resolver, quietly regardless of the active tab (no tab yank — the entry is marked when you enter Content). Clicking an entry navigates the canvas when exactly one candidate route exists and the id is held by one collection, verified by forward match after the navigation; ambiguity or a failed verification keeps the form-only fallback. The editor pane now follows the active entry (the seam #72's form takes over).
