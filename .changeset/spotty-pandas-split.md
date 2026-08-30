---
'@wojciechpiskorz/astroix': patch
---

Split the repeatable-rows cluster (`ArrayRows`, `RowWidget`, `defaultRowItem`) out of `field-widgets.tsx` into `array-rows.tsx`, with the shared leaf widgets in `value-widgets.tsx` — a pure file split, no behavior change (#156).
