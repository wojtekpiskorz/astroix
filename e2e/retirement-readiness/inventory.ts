import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The retirement-bound inventory (#214, AC-6): every deletion target A6
 * (#215) owes its proof to, as typed data. The evidence report
 * (docs/retirement-readiness.md) names these targets in prose; the
 * reconciliation test below holds the report, this inventory, and #215's
 * owned-path set in agreement — a target the report forgot, a path A6 does
 * not own, or an inventory entry pointing at a missing file all fail
 * readiness.
 *
 * Sources: ADR-0010's retirement-gate paragraph (what dies), #215's owned
 * paths + acceptance criteria (who may delete it), and the tree scan this
 * proof ran. Gaps — targets the retirement decision requires but #215 does
 * not own — are first-class data, not footnotes: they surface in the PR
 * body and the report so A6 starts with an explicit contract.
 *
 * Past the gate (#215, lane A6): the gaps G1–G4 were executed by the A6
 * PR itself under the disclosed-seams authorization (the readiness
 * report's reconciliation section is the authority), and the
 * reconciliation below now ASSERTS the deletion rather than the
 * pre-deletion tree — see `reconcileInventory`.
 */

/** One deletion target for A6. */
export interface DeletionTarget {
  /** Stable slug — the report and the reconciliation agree on these. */
  id: string;
  /** Tree paths the target occupies (existence-checked where glob-free). */
  paths: readonly string[];
  /** What it is, one line. */
  what: string;
  /** Where the retained replacement evidence lives. */
  evidence: readonly string[];
  /** Whether #215's owned-path list covers every path. */
  a6Owned: boolean;
  /** For !a6Owned targets: the reconciliation finding A6 must resolve. */
  gapNote?: string;
}

/** #215's owned paths, as chartered (the ownership fence for reconciliation). */
export const A6_OWNED_PATHS: readonly string[] = [
  'package.json',
  'src/node/**',
  'src/index.ts',
  'src/client/**',
  'tsup.config.ts',
  'vite.chrome.config.ts',
  'playwright.config.ts',
  'e2e/**/*.spec.ts',
  'e2e/pack-fixture/**',
  'e2e/src-fixture/**',
  'scripts/check-chrome-artifact.mjs',
  'scripts/check-dist-graph.mjs',
  'scripts/prepare-local-link.mjs',
  'scripts/prepare-pack-fixture.mjs',
  'scripts/prepare-src-link.mjs',
  'scripts/smoke.mjs',
  '.changeset/**',
  '.github/workflows/release.yml',
  '.github/workflows/snapshot.yml',
  '.github/workflows/ci.yml',
  'docs/manual-smoke.md',
  'docs/agents/release-loop.md',
];

/** The `src/core` compatibility shims that die at the gate (AGENTS.md, ADR-0010). */
const SRC_CORE_SHIMS: readonly string[] = [
  'src/core/collections.ts',
  'src/core/entry-writer.ts',
  'src/core/form-tree.ts',
  'src/core/indexer.ts',
  'src/core/matcher.ts',
  'src/core/route-resolver.ts',
  'src/core/splice-writer.ts',
];

export const DELETION_TARGETS: readonly DeletionTarget[] = [
  {
    id: 'integration-runtime',
    paths: ['src/node/**', 'src/index.ts'],
    what: 'The integration runtime: Vite plugin, middleware, watcher, and the /__astroix REST endpoints, plus the integration entry point.',
    evidence: [
      'B1 inspection + B2 edit corpora (e2e/behavior-contracts/{inspection,edit}) freeze the served and write behavior; the freeze specs re-derive them byte-for-byte',
      'readiness contracts leg re-derives every edit contract through packages/core',
      'readiness oracle leg re-compares live served payloads and write cycles against the frozen bytes',
    ],
    a6Owned: true,
  },
  {
    id: 'injected-chrome',
    paths: ['src/client/**'],
    what: 'The injected chrome: the legacy React shell, its adapters over the retained widgets, the compatibility re-export shims, and the integration-era smoke screens.',
    evidence: [
      'packages/app-shell/src/presentation is the retained prop-driven surface; its widget tests mount every widget over frozen fixtures',
      'e2e/retained-ui.spec.ts runs the two verticals end-to-end through the adapters over a disposable oracle',
      'readiness mount leg re-runs the presentation over contract-shaped data with zero runtime couplings',
    ],
    a6Owned: true,
  },
  {
    id: 'src-core-shims',
    paths: SRC_CORE_SHIMS,
    what: 'The one-line compatibility re-export shims keeping src/core import paths alive for the retirement-bound integration.',
    evidence: [
      "packages/core owns the moved modules with their unit suites (vitest config's non-vacuous core discovery guard)",
      'no retained consumer imports the shims — only src/node and src/client, both deletion targets themselves',
    ],
    a6Owned: false,
    gapNote:
      "GAP G1: AGENTS.md and ADR-0010 say the shims die at the retirement gate, but src/core/** is absent from #215's owned paths (only src/node, src/index.ts, src/client are listed). A6 must widen its owned set or a follow-up owns the shim deletion; the CRAP tooling (src/core/complexity.ts, crap.ts and their tests) STAYS — it is not part of this target.",
  },
  {
    id: 'build-surfaces',
    paths: ['tsup.config.ts', 'vite.chrome.config.ts'],
    what: "The integration build surfaces: the node-side tsup build and the prebuilt chrome bundle (ADR-0001's hybrid delivery), plus their npm scripts and dist outputs.",
    evidence: [
      "the canonical fixture builds standalone with zero astroix bytes (plain-build smoke + this readiness suite's fixture leg)",
      'no retained package consumes dist/ — packages/core and packages/app-shell export source',
    ],
    a6Owned: true,
  },
  {
    id: 'npm-artifact-checks',
    paths: ['scripts/check-chrome-artifact.mjs', 'scripts/check-dist-graph.mjs'],
    what: 'The publish-shape gates: chrome artifact check, node-side dist graph check, and publint over the published manifest.',
    evidence: [
      'the root becomes private with no publishable artifact (#215 AC-1), so the artifact shape has no subject left to gate',
    ],
    a6Owned: true,
  },
  {
    id: 'publication-machinery',
    paths: ['.changeset/**', '.github/workflows/release.yml', '.github/workflows/snapshot.yml'],
    what: 'The publication machinery: Changesets, the stable and snapshot release workflows, and the ci:publish/changeset scripts.',
    evidence: [
      'npm publication is paused by the rewrite (ADR-0010); A2 paused it mechanically, retirement deletes the machinery',
      'pre-alpha delivery is the packaged-artifact path (ADR-0008), recorded in docs/agents/release-loop.md',
    ],
    a6Owned: true,
  },
  {
    id: 'staging-scripts',
    paths: [
      'scripts/prepare-local-link.mjs',
      'scripts/prepare-pack-fixture.mjs',
      'scripts/prepare-src-link.mjs',
    ],
    what: 'The delivery-lane staging scripts: the publish-shaped local link, the npm-pack lane, and the source-mode lane.',
    evidence: [
      "ADR-0001's three e2e delivery lanes die at the retirement gate (ADR-0010)",
      'every spec that boots the oracle is itself a deletion target under target:legacy-e2e-and-oracle-specs; the staging scripts and those specs die together in this inventory',
    ],
    a6Owned: true,
  },
  {
    id: 'staging-lib',
    paths: ['scripts/oracle.mjs', 'scripts/oracle.d.mts'],
    what: 'The shared staging library the three prepare scripts build on (oracle locations, node_modules farming, dist build gate).',
    evidence: [
      'every caller is a deletion target: the three prepare scripts and, through them, the oracle boots',
    ],
    a6Owned: false,
    gapNote:
      "GAP G2: deleting the prepare scripts orphans scripts/oracle.mjs + oracle.d.mts, but neither path is in #215's owned list. A6 must widen or a follow-up removes them.",
  },
  {
    id: 'delivery-fixtures',
    paths: ['e2e/pack-fixture/**', 'e2e/src-fixture/**'],
    what: "The delivery-lane fixture inputs: the minimal pack oracle input (tracked) and the src lane's fixture (generated, currently absent from the tree).",
    evidence: [
      'their oracle copies are disposable and gitignored; with the staging scripts gone no lane generates or consumes them',
    ],
    a6Owned: true,
  },
  {
    id: 'legacy-e2e-and-oracle-specs',
    paths: ['e2e/*.spec.ts', 'playwright.config.ts'],
    what: 'The Playwright suites of the no-E2E interval: the freeze specs, the retained-UI regression, the plain-build smoke, and this readiness suite — replaced by a named no-product-E2E CI state whose product-E2E slot cannot pass empty.',
    evidence: [
      "the frozen corpora survive as contracts (validated serverlessly by the schema tests and this readiness suite's serverless legs)",
      'the canonical fixture build check survives as the named non-product lane (#215 AC: fixture build stays clean)',
      "product E2E returns with the web host (#240), per ADR-0010's no-E2E interval",
    ],
    a6Owned: true,
  },
  {
    id: 'oracle-machinery',
    paths: ['e2e/oracle.mjs', 'e2e/oracle.d.mts', 'e2e/contract-oracle/**'],
    what: 'The disposable-oracle machinery: oracle path constants, the boot/teardown server helper, and the B-lane capture pipelines.',
    evidence: [
      'every spec that boots the oracle is itself a deletion target under target:legacy-e2e-and-oracle-specs; the machinery dies with the runtime that boots the oracle',
      'the frozen corpora remain the evidence — contract truth stops being re-derivable and becomes the frozen standard the web host is judged against',
    ],
    a6Owned: false,
    gapNote:
      "GAP G3: e2e/contract-oracle/**, e2e/oracle.mjs, and e2e/oracle.d.mts are in no ticket's owned paths (#215 owns e2e/**/*.spec.ts and the named fixtures only, and lists e2e/behavior-contracts/** as forbidden — this machinery is neither). After A6 these files are dead code. A6 must widen its owned set or a follow-up owns the removal.",
  },
  {
    id: 'smoke-lane',
    paths: ['scripts/smoke.mjs'],
    what: 'The integration-era owner smoke script (?builder=1 wizard driver).',
    evidence: [
      "the smoke wizard UI it drives is part of src/client (this inventory's injected-chrome target)",
      "the rewrite's owner smoke is the packaged-artifact checklist (docs/manual-smoke.md, ADR-0008) — open finding #279 already tracks the repoint/retire decision",
    ],
    a6Owned: true,
  },
  {
    id: 'root-manifest',
    paths: ['package.json'],
    what: 'The root manifest as a publishable integration: exports/files/publishConfig/keywords, the npm-integration description, the #components/#hooks/#lib imports into src/client, the integration scripts, and the engines line.',
    evidence: [
      '#215 AC-1: the root becomes private with no publishable artifact',
      "the zero-injection guarantee: the canonical fixture output carries no astroix bytes (this readiness suite's fixture leg)",
    ],
    a6Owned: true,
  },
  {
    id: 'release-loop-instructions',
    paths: ['docs/agents/release-loop.md', 'docs/manual-smoke.md'],
    what: "The release-loop instructions' dormant npm-era sections and any integration-era smoke residue in the manual smoke doc — both files were rewritten by A1 for the rewrite and survive it; only their npm/integration-era sections are deletion targets.",
    evidence: [
      'ADR-0010: retirement removes the obsolete release instructions',
      'the pre-alpha packaged loop those docs now describe is the surviving subject matter (ADR-0008)',
    ],
    a6Owned: true,
    gapNote:
      "NOTE (not an ownership gap): both docs are #215-owned, but their current content is rewrite-forward — the deletion is section-scoped, not file-scoped. A6's PR should prune the dormant npm-loop sections, not delete the packaged-artifact loop.",
  },
  {
    id: 'crap-baseline-keys',
    paths: ['crap-baseline.json'],
    what: "The CRAP ratchet baseline's entries for src/node and src/client functions — stale keys once their functions are deleted (the file itself survives; entries only tighten or drop).",
    evidence: [
      'preflight runs over src/ + packages (AGENTS.md); after deletion the stale keys refer to nothing',
      'the sanctioned move is `npm run crap --update-baseline` in the deleting PR (AGENTS.md ratchet rules)',
    ],
    a6Owned: false,
    gapNote:
      "GAP G4 (procedural): crap-baseline.json and scripts/crap.mjs are not in #215's owned paths. The baseline update must land in A6's PR regardless — either widen the owned set for the one-file baseline update or record the procedure in the A6 ticket.",
  },
];

/** Targets #215 does not fully own — the reconciliation findings. */
export function inventoryGaps(): readonly DeletionTarget[] {
  return DELETION_TARGETS.filter((target) => !target.a6Owned);
}

/**
 * Deletion-target paths that survive the gate BY NAME (checked for
 * post-gate shape, never for absence): the section-scoped docs, the root
 * manifest (asserted private), and the ratchet baseline (asserted
 * stale-key-clean by preflight itself).
 */
const SURVIVORS = new Set([
  'package.json',
  'crap-baseline.json',
  'docs/agents/release-loop.md',
  'docs/manual-smoke.md',
]);

/**
 * The named no-product-E2E lane's own paths (ADR-0010's interval): the
 * Playwright runner and the glob it matches. `playwright.config.ts` is a
 * straight existence exemption; `e2e/*.spec.ts` is NOT — the surviving
 * spec set is asserted to equal exactly the one named smoke below.
 */
const DELIBERATE_LANE_SURVIVORS = new Set(['playwright.config.ts']);
const E2E_SPECS_GLOB = 'e2e/*.spec.ts';
const NAMED_NO_PRODUCT_E2E_SPEC = 'e2e/plain-build.spec.ts';

const REPORT_PATH = join('docs', 'retirement-readiness.md');

export interface Reconciliation {
  ok: true;
  targets: number;
  gaps: number;
  a6OwnedCoverage: number;
}

/**
 * Holds three artifacts in agreement — this inventory, the evidence
 * report, and the post-gate tree — and asserts the gate actually
 * happened. The report names every target with the exact token
 * `` `target:<id>` `` — that token is the reconciliation protocol, so a
 * renamed slug must move with its report row. Past the retirement gate
 * (#215, lane A6) the existence check is INVERTED from the A5 proof: then,
 * every non-glob path had to exist (the targets were named before they
 * died); now every deletion target's paths must be GONE — a resurrected
 * `src/index.ts` or a recreated `.changeset/` fails here, which is what
 * keeps this suite the durable record of the deletion instead of a
 * one-shot proof. The section-scoped survivors (`package.json`,
 * `crap-baseline.json`, and the two docs pruned by section, not deleted)
 * are exempted by name and carry their own post-gate shape checks.
 * Throws with a named finding on any disagreement; returns the summary.
 */
export function reconcileInventory(): Reconciliation {
  const report = readFileSync(join(process.cwd(), REPORT_PATH), 'utf8');

  // every inventory target is named in the report by its protocol token
  const missingInReport = DELETION_TARGETS.filter(
    (target) => !report.includes(`\`target:${target.id}\``),
  );
  if (missingInReport.length > 0) {
    throw new Error(
      `evidence report does not name: ${missingInReport.map((target) => target.id).join(', ')}`,
    );
  }

  // every protocol token in the report names a real target — no orphaned
  // or renamed slugs
  const slugs = new Set(DELETION_TARGETS.map((target) => target.id));
  const reportSlugs = [...report.matchAll(/`target:([a-z0-9-]+)`/g)]
    .map((match) => match[1])
    .filter((slug): slug is string => slug !== undefined);
  const unknown = [...new Set(reportSlugs)].filter((slug) => !slugs.has(slug));
  if (unknown.length > 0) {
    throw new Error(`report names targets absent from the inventory: ${unknown.join(', ')}`);
  }

  // every deletion target is actually deleted: exact paths and `/**`
  // roots must be absent from the tree, except the named survivors
  // (checked for shape below, not existence) and the named lane's runner.
  // The `e2e/*.spec.ts` glob is skipped here only because it gets a
  // STRICTER check of its own right after: the surviving spec set must
  // equal exactly the one named no-product-E2E smoke.
  const resurrected: string[] = [];
  for (const target of DELETION_TARGETS) {
    for (const path of target.paths) {
      if (SURVIVORS.has(path) || DELIBERATE_LANE_SURVIVORS.has(path) || path === E2E_SPECS_GLOB)
        continue;
      const exact = path.endsWith('/**') ? path.slice(0, -3) : path;
      if (existsSync(join(process.cwd(), exact))) resurrected.push(`${target.id}: ${path}`);
    }
  }
  if (resurrected.length > 0) {
    throw new Error(
      `deletion targets still present after the retirement gate: ${resurrected.join(', ')}`,
    );
  }

  // the interval's named lane is EXACTLY one spec: the glob above is not
  // a wholesale exemption. Anything else surviving under e2e/*.spec.ts
  // means an oracle-era spec resurrected — or product E2E landing without
  // its web-host ruling — and fails the reconciliation.
  const survivingSpecs = readdirSync(join(process.cwd(), 'e2e'))
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => join('e2e', name))
    .sort();
  if (survivingSpecs.length !== 1 || survivingSpecs[0] !== NAMED_NO_PRODUCT_E2E_SPEC) {
    throw new Error(
      `the no-product-E2E interval's spec set must be exactly [${NAMED_NO_PRODUCT_E2E_SPEC}], found: [${survivingSpecs.join(', ')}]`,
    );
  }

  // the surviving root manifest carries its post-gate shape: private,
  // with no publishable surface left (target:root-manifest, #215 AC-1)
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  if (manifest.private !== true) {
    throw new Error('package.json is not private — the root must expose no publishable artifact');
  }
  for (const field of ['exports', 'files', 'publishConfig', 'keywords']) {
    if (manifest[field] !== undefined) {
      throw new Error(`package.json still carries the publication field "${field}"`);
    }
  }

  return {
    ok: true,
    targets: DELETION_TARGETS.length,
    gaps: inventoryGaps().length,
    a6OwnedCoverage: DELETION_TARGETS.filter((target) => target.a6Owned).length,
  };
}
