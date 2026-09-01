# The frozen inspection-contract corpus (#216, lane B1)

Seven deterministic JSON fixtures — the observed, versioned inspection
behavior of the retired integration over the canonical plain fixture,
captured from disposable legacy-oracle runs (`e2e/.oracle-fixture` and
`e2e/contract-oracle/.oracle-where`). Validated against
`e2e/behavior-contracts/schema/inspection-contract.ts` (semver
`contractVersion`), hygiene-scanned for the artifacts #216 AC-4 forbids,
and re-derived byte-for-byte by `e2e/contracts-inspection.spec.ts` — that
last comparison is the freeze: if a fresh oracle run no longer produces
these bytes, the behavior changed and the contract must move deliberately.

## Regeneration

Regenerate with `node e2e/contract-oracle/capture.mjs` from the repo root
(boots both oracles; needs a chromium install — Playwright's own registry
path decides). Two regeneration triggers are legitimate:

- **Behavior change** — the legacy oracle or the canonical fixture changed
  what inspection serves. Expect a targeted diff and say what moved.
- **Formatter bump** — the corpus bytes are serialized through the repo's
  pinned Biome (see `serializeFixture` in `e2e/contract-oracle/live-capture.ts`),
  so a Biome (or any formatter) version bump re-churns the whole corpus as
  an unrelated diff. That is the documented trigger, not an accident:
  regenerate via capture and expect a whole-corpus diff. The freeze spec
  compares frozen bytes against the same pinned formatter, so both sides
  move together only when the pin itself moves.

Everything else is drift: the spec goes red on purpose.
