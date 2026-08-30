---
'@wojciechpiskorz/astroix': patch
---

Close the per-request/per-pass `ServerModuleRunner` after use (`ModuleRunner#close()`): each fresh runner pinned a `send` listener on the ssr hot channel, tripping `MaxListenersExceededWarning` after ~10 collections/schema/enumeration hits (#146)
