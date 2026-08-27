---
'@wojciechpiskorz/astroix': patch
---

Bidirectional sync (spec #13): the host watcher pushes `astroix:file-changed` over the Vite WebSocket (debounced per file, css/astro under the project src dir), and the chrome refetches — the open CodeMirror editor live-reloads external (IDE) edits when its document is clean, and the index payload refetches on every event. Chrome writes now carry the sha256 of the content they were based on; a disk mismatch answers 409 with the current contents, which the editor reloads ("changed on disk — reloaded") instead of splicing stale offsets into a shifted file. Manual-smoke sheet gains step 6b for the IDE round-trip.
