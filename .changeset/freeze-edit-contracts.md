---
'@wojciechpiskorz/astroix': patch
---

Freeze the edit, conflict, and output-byte contract corpus from the disposable legacy oracle: eight fixtures under `e2e/behavior-contracts/edit/` (CSS splices, Content whole-file writes, stale-hash conflicts, malformed-request negatives) with a versioned zod schema, a vitest-side validator suite, and a byte-for-byte freeze spec (#217).
