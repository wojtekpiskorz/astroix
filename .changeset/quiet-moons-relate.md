---
'@wojciechpiskorz/astroix': patch
---

feat: CM6 markdown body editor + toolbar for the Content vertical (#73)

CodeMirror 6 markdown editor for `entry.body` in the shared `editor/` module, with a bold/heading/link toolbar emitting markdown around the selection. The content pane mounts it on the first body-bearing entry until #72's form owns the pane; the emitted-markdown seam (`onChange`) is what #74's auto-write loop connects. Native Cmd+Z undoes through toolbar and typed transactions.
