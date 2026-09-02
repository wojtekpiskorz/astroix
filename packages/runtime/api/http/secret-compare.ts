import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The one timing-safe secret comparator of the API surface (#234, F2;
 * ADR-0006 §3's capability law): presented authority is compared by
 * SHA-256 digest — fixed-length buffers, so `timingSafeEqual` never
 * throws on a length mismatch and no early exit or length oracle
 * leaks how far a forgery got. One home for both secret tables (the
 * host-capability grants and the client bindings); a secret comparison
 * anywhere else on this surface is a defect.
 */

/** True when `presented` and `expected` are the same secret — constant-shape comparison over digests. */
export function sameSecret(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}
