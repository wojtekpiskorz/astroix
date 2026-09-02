import type { AdapterError } from '../adapter-error';
import { seamRejection } from '../adapter-error';

/**
 * The routes lane's seam-class binding (#229): every seam the routes
 * lane probes is fail-closed private, so the class is bound once here
 * and the probes name only the seam and the mismatch. The message
 * template itself is single-homed in `adapter-error.ts` `seamRejection`
 * (#311) — this module states no format of its own.
 */

/** Builds the fail-closed-private `seam-rejected` rejection for one probe of `seam`. */
export function seamRejected(seam: string, expected: string, observed: string): AdapterError {
  return seamRejection(seam, 'fail-closed private', expected, observed);
}
