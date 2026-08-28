---
"@wojciechpiskorz/astroix": patch
---

Preflight becomes a full-src ratchet and the generated ui/ tier goes watch-only (owner rulings, issue #62).

- `bun run preflight` now evaluates all of `src/` against the baseline on every run — coverage regressions from test-weakening PRs fail even when no product function is touched; the diff survives only as `[PR touches this file]` annotations and the CI table's in-PR marks.
- `src/client/components/ui/` (shadcn-generated, regenerated per ADR-0002) is watch-only: rows stay in the report and the CI table (`·gen`), the gate never blocks them (`stop: Infinity`), the baseline can never absorb them.
- Glossary: `preflight` and `watchlist` rows updated to the ruled semantics.
