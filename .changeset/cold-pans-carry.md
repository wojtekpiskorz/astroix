---
'@wojciechpiskorz/astroix': patch
---

Chrome URL carries the canvas position (#110): every canvas load mirrors the iframe's path+search into a `?canvas=` param via `history.replaceState` (the builder marker never leaks in), boot with the param wins over deriving the iframe src from the chrome page's own URL — a refresh or shared link re-opens the builder with the canvas where it was, back button untouched.
