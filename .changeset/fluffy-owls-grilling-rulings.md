---
"@wojciechpiskorz/astroix": patch
---

Post-#61 grilling rulings (2026-08-29): ADR-0002 records the Base UI dialog-portal consequence (Tailwind resolves in `document.body` via dual sheet adoption; `.dark` token scope does not cross the shadow boundary — re-scope today, `container: ShadowRoot` the supported alternative at a future chrome-level wrapper); CONTEXT.md gains the smoke vocabulary (smoke gate, hint pill, wizard, copy report); the e2e suite guards `SMOKE_STEPS` against drift with `docs/manual-smoke.md` (ids compared in the spec — the unit doctrine stays pure-modules-over-fixtures).
