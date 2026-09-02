---
'@wojciechpiskorz/astroix': patch
---

Prove retirement readiness against the fixture, contracts, and retained UI (A5). New readiness suite (`e2e/retirement-readiness.spec.ts` + `e2e/retirement-readiness/`): six aggregate legs that validate every frozen contract family through its schema and re-derive the edit contracts through `packages/core`, scan and run the app-shell presentation over contract-shaped data (zero `/__astroix`/fetch/Vite couplings, dedicated vitest mount lane), confirm the canonical fixture is plain and builds with zero astroix bytes, enumerate the non-empty unit/contract/fixture counts ledger, reconcile the deletion-target inventory with #215's owned paths, and compare one live disposable-oracle boot against the frozen corpora. The durable evidence report lands at `docs/retirement-readiness.md`, naming all 15 deletion targets and the 4 reconciliation gaps (G1–G4) A6 must own.
