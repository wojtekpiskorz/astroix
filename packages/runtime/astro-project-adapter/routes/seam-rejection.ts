import type { AdapterErrorDetails } from '../adapter-error';
import { AdapterError } from '../adapter-error';

/**
 * The routes lane's single statement of the adapter's seam-rejection
 * template (#229, review round 1): `seam-readers.ts` keeps its own
 * (private, E1's module — imported, never edited), so this lane states
 * the message format exactly once here and every probe it owns rejects
 * through it. Every seam the routes lane probes is fail-closed private;
 * the class rides with the template.
 */

/** Builds the fail-closed-private `seam-rejected` rejection for one probe of `seam`. */
export function seamRejected(seam: string, expected: string, observed: string): AdapterError {
  const details: AdapterErrorDetails = {
    seam,
    seamClass: 'fail-closed private',
    expected,
    observed,
  };
  return new AdapterError(
    'seam-rejected',
    `AstroProjectAdapter seam rejection at ${seam}: expected ${expected}; observed ${observed}`,
    details,
  );
}
