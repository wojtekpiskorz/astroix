import type { ExactPair } from './certified-pair';
import { CERTIFIED_PAIRS, isCertifiedPair, uncertifiedPairError } from './certified-pair';
import { resolveInstalledPair } from './installed-pair';

/**
 * The pair gate (ADR-0005: an uncertified pair "fails before project
 * config executes"). `certifyPairBeforeConfig` resolves the installed
 * pair, checks exact membership, and only then hands the certified pair
 * to `loadProjectConfig` — the callback stands for every downstream act
 * that executes or imports the managed project's configuration. A
 * rejection therefore lands strictly before any project config can run,
 * and carries the detected pair, the certified pairs, and the rejected
 * contract (`uncertified-pair`, from `certified-pair.ts`).
 */
export async function certifyPairBeforeConfig<T>(
  input: {
    readonly projectRoot: string;
    /** Defaults to `CERTIFIED_PAIRS`; overridable so certification can prove the gate itself. */
    readonly certifiedPairs?: readonly ExactPair[];
  },
  loadProjectConfig: (certified: ExactPair) => Promise<T>,
): Promise<T> {
  const certifiedPairs = input.certifiedPairs ?? CERTIFIED_PAIRS;
  const detected = await resolveInstalledPair(input.projectRoot);
  if (!isCertifiedPair(detected, certifiedPairs)) {
    throw uncertifiedPairError(detected, certifiedPairs);
  }
  return loadProjectConfig(detected);
}
