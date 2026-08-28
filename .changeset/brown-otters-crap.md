---
"@wojciechpiskorz/astroix": patch
---

Crap4ts risk layer: static CRAP/CC checks wired into the review flow (dev-only tooling, no runtime surface).

- New pure modules: `src/core/complexity.ts` (per-function cyclomatic complexity — oxc-parser engine with a tsc oracle, probe-pinned ESLint-classic counting) and `src/core/crap.ts` (istanbul join, CRAP score, Uncle-Bob bands, baseline-ratchet evaluation).
- `bun run crap` — full risk report; `bun run preflight` — hard stop over the PR diff scope (CRAP ≥ 30 in src/core, CC ≥ 15 in src/node + src/client); pre-commit hook warns at CC ≥ 10 on staged functions (`bun run hooks` wires it, no hook manager).
- CI (`ai-review.yml`) recomputes the table from scratch and feeds it to the advisory reviewer prompt; local runs are advisory.
- Baseline calibrated once (`crap-baseline.json`); from here it only tightens. New devDeps: `oxc-parser`, `@vitest/coverage-v8`.
