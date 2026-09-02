/**
 * The certified exact Astro/Vite pairs (ADR-0005 compatibility contract,
 * ruling #206, charter #197): acceptance is driven by exact pairs, never
 * by semver ranges — an entry here records one fully proven combination
 * and nothing broader. The first and currently only certified pair is
 * `astro@7.2.10 + vite@8.2.2`, proven by the #206 adapter spike
 * (`spikes/issue-206-astro-project-adapter`, commit `274beac`) and
 * re-proven for the product adapter by the certification suite under
 * `astro-project-adapter/certification/` (#225).
 *
 * A new pair enters only through a certification update: a full
 * compatibility-fixture run over a real install of the exact pair. No
 * semver widening without one (#225 migration policy).
 */

import type { AdapterErrorDetails, ExactPairValue } from './adapter-error';
import { AdapterError } from './adapter-error';

/** One exact certified Astro/Vite pair. */
export type ExactPair = ExactPairValue;

/**
 * The certified set. Exactly one pair is certified today; the array shape
 * exists because certification is a set that grows one proven pair at a
 * time — never a range.
 */
export const CERTIFIED_PAIRS: readonly ExactPair[] = Object.freeze([
  Object.freeze({ astro: '7.2.10', vite: '8.2.2' }),
]);

/**
 * The contract every pair gate rejection names — the charter's wording
 * (#206): certification must pass before project config executes.
 */
export const PAIR_CERTIFICATION_CONTRACT =
  'exact Astro/Vite pair certification must pass before project config executes';

/** The diagnostic form of a pair: `astro@<version> + vite@<version>`. */
export function formatPair(pair: ExactPairValue): string {
  return `astro@${pair.astro} + vite@${pair.vite}`;
}

/**
 * Exact-string pair membership: a detected pair is certified only when
 * both versions equal a certified entry character for character. There is
 * deliberately no semver interpretation here — `7.2.11` satisfies no
 * `7.2.10` entry, and a range-looking drift is still a rejection.
 */
export function isCertifiedPair(
  detected: ExactPairValue,
  certified: readonly ExactPair[] = CERTIFIED_PAIRS,
): boolean {
  return certified.some((pair) => pair.astro === detected.astro && pair.vite === detected.vite);
}

/**
 * The rejection thrown for an uncertified detected pair — the charter's
 * diagnostic shape: detected pair, certified pairs, rejected contract.
 */
export function uncertifiedPairError(
  detected: ExactPairValue,
  certified: readonly ExactPair[] = CERTIFIED_PAIRS,
): AdapterError {
  const certifiedList =
    certified.length === 0 ? 'none' : certified.map((pair) => formatPair(pair)).join(', ');
  const details: AdapterErrorDetails = {
    detected: { astro: detected.astro, vite: detected.vite },
    certified: certified.map((pair) => ({ astro: pair.astro, vite: pair.vite })),
    rejectedContract: PAIR_CERTIFICATION_CONTRACT,
  };
  return new AdapterError(
    'uncertified-pair',
    `AstroProjectAdapter compatibility rejection: detected ${formatPair(detected)}; certified pairs: ${certifiedList}; failed contract: ${PAIR_CERTIFICATION_CONTRACT}`,
    details,
  );
}
