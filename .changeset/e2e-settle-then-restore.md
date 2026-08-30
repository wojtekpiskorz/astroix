---
'@wojciechpiskorz/astroix': patch
---

e2e settle-then-restore (#114): `restoreEntry` first waits out the auto-write debounce (entry file + data-store quiet together past the ~300ms window) before writing the original bytes back, closing the race where a late debounced write re-dirtied the fixture entry after the restore; the fixture dev script now heals any dirty fixture content (git restore, loud log per file) before the playwright-driven server boots.
