---
'@wojciechpiskorz/astroix': patch
---

Fix two retries:0 e2e flakes with product-side roots: a superseded reverse navigation no longer leaves a stale arm that eats the next plain navigation's selection clear (#140), and select-mode handlers re-attach to the canvas iframe's document on every load so clicks in a reloaded canvas still select (#141).
