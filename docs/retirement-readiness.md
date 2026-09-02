# Retirement readiness — the evidence report

Status: **passed** (2026-09-01, lane A5, [#214](https://github.com/wojtekpiskorz/astroix/issues/214); ADR-0010's retirement gate) · **gate executed** (2026-09-01, lane A6, [#215](https://github.com/wojtekpiskorz/astroix/issues/215) — see [the recorded disposition](#a6-executed--the-recorded-disposition-215-lane-a6) at the end)

This report is the durable record of the retirement-readiness proof. It is
not hand-maintained folklore: the readiness suite
(`e2e/retirement-readiness.spec.ts` + `e2e/retirement-readiness/`)
validates every claim below on each run, and its inventory reconciliation
holds this document in agreement with the typed deletion-target inventory
(`e2e/retirement-readiness/inventory.ts`) and with #215's owned paths — a
target this report forgot, a slug it renamed, or a path absent from the
tree fails the suite. The counts ledger below was emitted by the suite's
counts leg at the passing run; the suite re-derives it live.

A6 ([#215](https://github.com/wojtekpiskorz/astroix/issues/215)) may start
from this proof. The deletion targets it names are inventoried in the
[table below](#the-deletion-target-inventory) — every `target:` slug is the
reconciliation protocol between this report and the suite.

## What was proved, and how

The readiness suite is the aggregate entry. Six legs, ordered serverless
first so everything but the oracle comparison runs in every environment:

1. **Contracts (serverless).** Every frozen behavior contract — all 15
   fixtures across the six families (inspection, edit, conflict, selector,
   route, output-byte) — parses through its versioned schema, every family
   is non-empty with real checks, and the derived side of every edit
   contract re-derives byte-identically through the **retained** pure
   modules (`packages/core`: splice-writer, entry-writer, route-resolver).
   Route resolution recomputes through the retained resolver over the
   frozen payloads and reproduces the frozen rows. No legacy runtime
   source is imported anywhere in the leg.
2. **Retained UI (serverless).** The app-shell presentation surface
   (`packages/app-shell/src/presentation/`) is scanned for runtime
   couplings — `/__astroix` URLs, `fetch`, SSE/websocket transports,
   `import.meta`, global window/navigator reaches — and carries **zero**
   (test helpers are exempted by name: `mount.tsx`, `fixtures.ts`). Its
   mount lane (a dedicated vitest config under `e2e/retirement-readiness/`)
   runs the retained widgets — `RuleList`, `EntryTree`, `WriteStatusBadge` —
   with real React over props loaded from the frozen corpora through the
   versioned schemas, imported via the package's `./presentation` export.
3. **Fixture (serverless).** The canonical fixture (`e2e/fixture/`) is
   plain — no astroix bytes in source or config, no astroix dependency in
   the manifest or lockfile — and a clean production build emits a
   non-empty `dist/` with **zero astroix bytes** (case-sensitive; the
   fixture hero's "Astroix fixture" is capital-A and not a producer).
4. **Counts (serverless).** Every quality lane is enumerated and
   non-empty: vacuity fails the proof (see the ledger below).
5. **Inventory (serverless).** This report, the typed inventory, and
   #215's owned paths agree; the gaps are counted and carried below.
6. **Oracle comparison (chromium-gated, one boot).** A single disposable
   oracle boot (`e2e/.oracle-fixture`, regenerated pristine) serves as the
   evidence producer for a live comparison against the frozen contracts:
   the served index/collections/routes/raw-truth payloads deep-equal the
   frozen corpus, route resolution recomputes identically over live
   payloads, and the frozen `css-splice` and `css-conflict` cycles
   reproduce exactly — response shapes, disk bytes, hashes, untouched
   windows. The canonical fixture itself is never touched by the oracle
   (the copy is disposable and gitignored); the legacy runtime is never
   imported — it only serves the HTTP the comparison talks to.

## The counts ledger

Recorded at the passing run; re-derived live by the suite's counts leg
(`vitest list --json` for the unit/validator lanes, static enumeration for
the authored Playwright specs, directory counts for the frozen corpus). A
zero in any lane fails readiness.

| lane | kind | count |
| --- | --- | --- |
| `unit:src` | unit | 150 |
| `unit:packages/core` | unit | 114 |
| `unit:packages/app-shell` | unit | 39 |
| `contract:schema-validators` | contract | 35 |
| `contract:inspection-corpus` | contract | 7 fixtures |
| `contract:edit-corpus` | contract | 8 fixtures |
| `contract:freeze-suites` | contract | 9 |
| `fixture:plain-build` | fixture | 1 |
| `fixture:retained-ui` | fixture | 2 |
| `fixture:readiness` | fixture | 6 |

Cross-check: the vitest lanes (150 + 114 + 39 + 35) sum to the 338-test
`npm test` baseline; the Playwright lanes (1 + 2 + 6 + the freeze suites'
9) are `npm run test:e2e`'s aggregate. The contract families carry 3–7
fixtures each with 5–17 named checks.

## The deletion-target inventory

Every target A6 owes its deletion to. `owned` means #215's owned-path list
covers it; the gaps follow the table. This inventory is the typed data in
`e2e/retirement-readiness/inventory.ts` — the suite reconciles it with
this report and the tree on every run.

| target | what dies | replacement evidence | owned by #215 |
| --- | --- | --- | --- |
| `target:integration-runtime` | `src/node/**` + `src/index.ts`: the Vite plugin, middleware, watcher, `/__astroix` endpoints, integration entry | B1/B2 corpora freeze the served + write behavior; freeze specs re-derive byte-for-byte; readiness legs 1 + 6 | yes |
| `target:injected-chrome` | `src/client/**`: the legacy shell, adapters, re-export shims, integration-era smoke screens | `packages/app-shell/src/presentation` + its widget tests; `retained-ui.spec.ts`; readiness leg 2 | yes |
| `target:src-core-shims` | the seven `src/core/*` compatibility re-export shims | `packages/core` owns the moved modules + their suites; no retained consumer imports the shims | **no — G1** |
| `target:build-surfaces` | `tsup.config.ts`, `vite.chrome.config.ts`, the build/dev scripts, `dist/` outputs | the canonical fixture builds standalone (readiness leg 3); no retained package consumes `dist/` | yes |
| `target:npm-artifact-checks` | `check-chrome-artifact.mjs`, `check-dist-graph.mjs`, publint gate + scripts | the root goes private with no publishable artifact (#215 AC-1) | yes |
| `target:publication-machinery` | `.changeset/**`, `release.yml`, `snapshot.yml`, `ci:publish`/`changeset` scripts | publication paused by the rewrite (ADR-0010); delivery is the packaged artifact (ADR-0008) | yes |
| `target:staging-scripts` | `prepare-local-link.mjs`, `prepare-pack-fixture.mjs`, `prepare-src-link.mjs` | ADR-0001's three delivery lanes die at the gate (ADR-0010); every spec that boots the oracle is itself a deletion target under `target:legacy-e2e-and-oracle-specs` | yes |
| `target:staging-lib` | `scripts/oracle.mjs` + `scripts/oracle.d.mts` (the shared staging library) | every caller is a deletion target | **no — G2** |
| `target:delivery-fixtures` | `e2e/pack-fixture/**`, `e2e/src-fixture/**` | their disposable oracle copies are gitignored; no lane generates or consumes them after the staging scripts die | yes |
| `target:legacy-e2e-and-oracle-specs` | `e2e/*.spec.ts` + `playwright.config.ts`: the freeze specs, retained-UI regression, plain-build smoke, and this readiness suite | replaced by the named no-product-E2E CI state (cannot pass an empty product-E2E slot); corpora survive as contracts; product E2E returns with the web host (#240) | yes |
| `target:oracle-machinery` | `e2e/oracle.mjs`, `e2e/oracle.d.mts`, `e2e/contract-oracle/**` | every spec that boots the oracle is itself a deletion target under `target:legacy-e2e-and-oracle-specs`, dying with the runtime that boots the oracle; the corpora remain the frozen standard | **no — G3** |
| `target:smoke-lane` | `scripts/smoke.mjs` (the `?builder=1` wizard driver) | the wizard UI is part of the injected chrome; the rewrite's owner smoke is the packaged-artifact checklist (`docs/manual-smoke.md`, ADR-0008); #279 (repoint-or-retire) closed by the gate's deletion of the script itself (#291) | yes |
| `target:root-manifest` | the root `package.json` as a publishable integration: exports/files/publishConfig/keywords, the `#components`-into-`src/client` imports map, integration scripts, engines | #215 AC-1 (root private, no artifact); zero-injection proof (readiness leg 3) | yes |
| `target:release-loop-instructions` | the dormant npm-era sections of `docs/agents/release-loop.md` + `docs/manual-smoke.md` | both files were rewritten by A1 for the rewrite and survive it — the deletion is section-scoped, not file-scoped (ADR-0010) | yes (note) |
| *(survivor)* root `CHANGELOG.md` — Changesets' generated output | kept as provenance: the 31-section version history (0.0.1–0.0.31) of the retired integration; nothing generates it anymore and nothing reads it as authority | — | — |
| `target:crap-baseline-keys` | the `crap-baseline.json` entries for `src/node`/`src/client` functions | the ratchet rule (AGENTS.md): entries only tighten or drop; `npm run crap --update-baseline` lands in the deleting PR | **no — G4** |

## Reconciliation gaps (the A6 contract)

Four findings — targets the retirement decision requires but #215's
owned-path list does not cover. They are findings, not blockers: A6 must
either widen its owned set or delegate each to a named follow-up before
the lane closes.

- **G1 — `target:src-core-shims`.** AGENTS.md and ADR-0010 say the
  `src/core` compatibility shims die at the retirement gate, but #215 owns
  only `src/node/**`, `src/index.ts`, and `src/client/**`. The CRAP
  tooling (`src/core/complexity.ts`, `crap.ts` + tests) is **not** part of
  this target and survives.
- **G2 — `target:staging-lib`.** Deleting the three prepare scripts
  orphans `scripts/oracle.mjs` + `scripts/oracle.d.mts`; neither path is
  in #215's owned list.
- **G3 — `target:oracle-machinery`.** `e2e/contract-oracle/**`,
  `e2e/oracle.mjs`, and `e2e/oracle.d.mts` are in no ticket's owned paths
  (#215 owns `e2e/**/*.spec.ts` and the named delivery fixtures; it lists
  `e2e/behavior-contracts/**` as forbidden — this machinery is neither).
  After A6 these files are dead code: the freeze specs that boot the
  oracle die with the runtime.
- **G4 — `target:crap-baseline-keys`.** `crap-baseline.json` and
  `scripts/crap.mjs` are not in #215's owned list; the stale-key cleanup
  (`npm run crap --update-baseline`) must land in A6's PR regardless.

One non-ownership note: `target:release-loop-instructions` — both docs are
#215-owned, but their current content is rewrite-forward; A6 should prune
the dormant npm-loop sections, not delete the packaged-artifact loop they
now describe.

## Acceptance criteria → evidence

| #214 AC | evidence |
| --- | --- |
| AC-1 — all contract families validated, no legacy source as replacement implementation | readiness legs 1 + 6: schema validation + retained-core re-derivation + live oracle comparison; the legs import only `packages/core`, the schemas, and the frozen corpus |
| AC-2 — fixture stays plain; oracle used only for evidence comparison | readiness leg 3 (plainness + zero-byte build) + leg 6 (the only oracle consumer; the canonical fixture is never booted with the integration) |
| AC-3 — presentation runs against typed contract-shaped data, no `/__astroix` fetches or Vite handles | readiness leg 2: zero-coupling scan + the mount lane over schema-validated fixtures; the C2 widget tests carry the deep behavior |
| AC-4 — counts recorded, every lane non-empty | the counts ledger above; `assembleCountsLedger` throws on any zero |
| AC-5 — clean production build with no Astroix in the fixture output | readiness leg 3 (mirrors and composes the `plain-build.spec.ts` smoke) |
| AC-6 — durable report naming every deletion target | this document, reconciled with `inventory.ts` and #215 by readiness leg 5 |

## The readiness suite's own fate

This suite is itself retirement-bound (`target:legacy-e2e-and-oracle-specs`
covers `e2e/*.spec.ts`): leg 6 cannot outlive the runtime it boots. The
serverless legs (1–5) are the natural seed of A6's named no-product-E2E
state — the corpus validation, coupling scan, counts discipline, and
fixture build check all survive deletion unchanged — but the disposition
is #215's call under its owned paths, not this proof's.

## A6 executed — the recorded disposition (#215, lane A6)

The retirement gate ran; this section is the record of what A6 did with
this report's inventory and suite. The A5 prose above is unchanged
history; where it says "may start from this proof," it now has.

**The suite.** The five serverless legs survive as
`e2e/retirement-readiness/readiness.test.ts` — converted from Playwright
to vitest, running under the root vitest config (`npm test`) — and the
presentation mounts (`presentation-mount.test.tsx`) join that same root
run as a sibling file (advisory round 1 on the A6 PR deleted the
vitest-spawns-vitest detour the Playwright era needed; the dedicated
mount config is gone). The Playwright aggregate
(`e2e/retirement-readiness.spec.ts`), leg 6
(`oracle-comparison.ts`), the freeze specs, the retained-UI regression,
the disposable-oracle machinery, and `e2e/ports.ts` (its every consumer
died) are deleted. Exactly one Playwright spec survives —
`e2e/plain-build.spec.ts`, the **named no-product-E2E lane** in CI
(ADR-0010's interval clause: the step is named, honest, and cannot pass
an empty product-E2E slot; Playwright fails a config matching zero
specs — and the inventory reconciliation pins the surviving spec set to
exactly that one file). The corpus stays frozen: contract truth is no
longer re-derivable, and the schema validators plus legs 1 and 4 keep it
validated and non-vacuous.

**The gaps.** All four were executed by the A6 PR under the
disclosed-seams authorization this report's reconciliation section
recorded: G1 — the seven `src/core` re-export shims deleted (the CRAP
tooling `complexity.ts`/`crap.ts` stays, not a shim); G2 —
`scripts/oracle.mjs` + `scripts/oracle.d.mts` deleted with their callers;
G3 — `e2e/contract-oracle/**`, `e2e/oracle.mjs`, `e2e/oracle.d.mts`
deleted; G4 — `crap-baseline.json` verified stale-key-clean (its only
entry is a live `packages/core` function; nothing to drop), with
`scripts/crap.mjs`'s tier labels synced to the post-gate tree.

**The reconciliation, inverted.** `e2e/retirement-readiness/inventory.ts`
still holds the 15 rows and the slug protocol, but its existence check
flipped: every deletion target's paths must now be **absent** (a
resurrected `src/index.ts` or recreated `.changeset/` fails readiness),
the section-scoped survivors (`package.json`, `crap-baseline.json`, the
two pruned docs) are exempt by name, and the root manifest is asserted
private with no publication fields.

**The post-gate counts ledger** (emitted live by leg 4 on the A6 branch;
`npm test` = 264 vitest tests, `npm run test:e2e` = 1 spec):

| lane | kind | count |
| --- | --- | --- |
| `unit:src` | unit | 67 |
| `unit:packages/core` | unit | 114 |
| `unit:packages/app-shell` | unit | 39 |
| `contract:schema-validators` | contract | 35 |
| `contract:inspection-corpus` | contract | 7 fixtures |
| `contract:edit-corpus` | contract | 8 fixtures |
| `contract:readiness-mount` | contract | 4 |
| `fixture:plain-build` | fixture | 1 |
| `fixture:readiness` | fixture | 5 |

The unit drop from A5's ledger is the deletion itself: `src/` keeps only
the CRAP tooling layer's 67 tests (from 150), and the freeze suites'
9 oracle-boot tests, the retained-UI regression's 2, and the readiness
aggregate's 6 Playwright tests are gone with the runtime they booted —
replaced by the 5 serverless legs and the named single-spec lane above.
