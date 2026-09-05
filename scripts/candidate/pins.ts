/**
 * The chartered pin table of the restricted-candidate workflow (#259,
 * L2): the EXACT versions a pre-alpha candidate must be assembled
 * from, straight off the ticket's charter — bundled Node 24.20.0
 * (module ABI 137), Electron 44.1.0, Electron Forge 7.11.2, the one
 * certified Astro/Vite pair (ADR-0005), minimum-OS metadata 13.5, and
 * the one product shape (macOS arm64 — ADR-0008).
 *
 * `reconcilePins` is the pin-drift law: the repo's own pin tables
 * (`packages/runtime/src/internal/packaged-assets.ts` +
 * `apps/desktop/src/forge/product.ts`, read through repo-pins.ts)
 * must EQUAL this charter in every field — a drifted repo pin fails
 * the candidate before anything is built (a pin drift is a STOP, never
 * a silent substitution). Pure: both sides are passed in, so the
 * focused self-tests prove every drift direction deterministically.
 */

/** The charter (#259): the exact pins a candidate is assembled from. */
export const CHARTER_PINS = Object.freeze({
  node: 'v24.20.0',
  nodeAbi: '137',
  electron: '44.1.0',
  forge: '7.11.2',
  pair: Object.freeze({ astro: '7.2.10', vite: '8.2.2' }),
  minimumMacOS: '13.5',
});

/** The manifest's pins section — the real shapes, replacing loose records. */
export interface ManifestPinTables {
  readonly charter: typeof CHARTER_PINS;
  readonly repo: RepoPins;
}

/** The product shape a candidate is assembled for (ADR-0008). */
export const CHARTER_PLATFORM = Object.freeze({ os: 'darwin', arch: 'arm64' });

/** The repo's pin-table shape, as repo-pins.ts reads it. */
export interface RepoPins {
  readonly node: string;
  readonly electron: string;
  readonly forge: string;
  readonly pair: { readonly astro: string; readonly vite: string };
  readonly minimumMacOS: string;
}

/** One pin-drift finding: the field, the repo's declared value, the charter's. */
export interface PinFinding {
  readonly field: string;
  readonly declared: string;
  readonly expected: string;
}

/**
 * Reconciles the repo's pin tables against the charter. Empty findings
 * = green; every finding is a field-named drift that FAILS the
 * candidate (the CLI prints each one and exits nonzero).
 */
export function reconcilePins(charter: typeof CHARTER_PINS, repo: RepoPins): PinFinding[] {
  const findings: PinFinding[] = [];
  const compare = (field: string, declared: string, expected: string): void => {
    if (declared !== expected) findings.push({ field, declared, expected });
  };
  compare('node', repo.node, charter.node);
  compare('electron', repo.electron, charter.electron);
  compare('forge', repo.forge, charter.forge);
  compare('pair.astro', repo.pair.astro, charter.pair.astro);
  compare('pair.vite', repo.pair.vite, charter.pair.vite);
  compare('minimumMacOS', repo.minimumMacOS, charter.minimumMacOS);
  return findings;
}
