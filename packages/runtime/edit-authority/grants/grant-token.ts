import { randomBytes } from 'node:crypto';

/**
 * The opaque resource-grant token (#223, ADR-0006 §6): per-activation,
 * CSPRNG-backed, never derived from a path, an index, or any discovery
 * fact — the same species as the one-use boot capability (#222) and the
 * protocol's 256-bit request authority (ADR-0006 §3): 32 random bytes in
 * base64url, 43 characters. The token is the only write authority the
 * browser ever holds; the wire grant around it is a claim, and the
 * issuing edit authority re-validates the full server-side grant table
 * at planning and (again, in the executor lane) immediately before
 * commit.
 */

/** Grant entropy is exactly 256 bits — the ADR-0006 §3 species, base64url-rendered. */
const GRANT_TOKEN_BYTES = 32;

/** 32 bytes → 43 base64url characters; the exact shape a valid wire token carries. */
export const GRANT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Mints a fresh, never-before-used token. The only minting path: server
 * -side discovery/planning issuance through the grant table — a browser
 * can hold one, echo one, and never construct an authoritative one.
 */
export function mintGrantToken(): string {
  return randomBytes(GRANT_TOKEN_BYTES).toString('base64url');
}

/**
 * Structural validation of a token candidate — shape only. Production
 * use: the grant table's authorize pre-filter, so a string that cannot
 * be a minted token fails before Map membership (and never hashes
 * attacker-sized input). Membership stays the table's decision; a
 * well-shaped stranger is still an unknown grant, and no meaning is
 * ever read out of the value.
 */
export function isGrantTokenShape(token: string): boolean {
  return GRANT_TOKEN_PATTERN.test(token);
}
