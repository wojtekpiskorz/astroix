import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { type ProjectKey, projectKeySchema } from '@wojciechpiskorz/astroix-protocol';

/**
 * Registry identity (ADR-0006 §1): the canonical root and the ProjectKey.
 * The two are deliberately unrelated — identity comes from the filesystem
 * (realpath + its own case semantics), routing from 128 bits of CSPRNG
 * entropy. Deriving the key from the root would make it identity, which
 * the ADR forbids.
 */

/** RFC 4648 base32, lowercased — the DNS-safe alphabet of a ProjectKey. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** ProjectKey entropy is exactly the protocol's 128 bits (ADR-0006 §1). */
const PROJECT_KEY_BYTES = 16;

/** The thrown shape of a root that cannot become a canonical root. */
export class RootUnavailableError extends Error {
  constructor() {
    // No interpolated path, errno, or system text: the message must be
    // safe to surface verbatim in any control-plane diagnostic.
    super('the granted directory is unavailable or is not a directory');
    this.name = 'RootUnavailableError';
  }
}

/**
 * Renders exactly 16 bytes as the 26-char lowercase-Base32 ProjectKey
 * (ceil(128 / 5) = 26 characters; the final character carries the last
 * 3 bits zero-padded to 5, which is why generated keys always end in a
 * character from the even-index set — the encoding of 128 bits, not a
 * constraint on entropy).
 */
export function encodeProjectKey(bytes: Uint8Array): ProjectKey {
  if (bytes.length !== PROJECT_KEY_BYTES) {
    throw new Error(`project key entropy must be ${PROJECT_KEY_BYTES} bytes`);
  }
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 0b11111];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0b11111];
  }
  return projectKeySchema.parse(out);
}

/**
 * Allocates a fresh record-lifetime ProjectKey that is unique among
 * `taken` (collision odds are 2⁻¹²⁸; the check is a structural invariant,
 * not a practical defense). Never reuses a removed record's key unless
 * the same 128 bits are drawn again — rotation on remove/re-register is
 * by construction, not bookkeeping.
 */
export function allocateProjectKey(taken: ReadonlySet<string>): ProjectKey {
  for (;;) {
    const candidate = encodeProjectKey(randomBytes(PROJECT_KEY_BYTES));
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The canonical root (ADR-0006 §1): `fs.realpath` on the native path —
 * resolving root and intermediate symlinks and returning the on-disk
 * case — plus a directory check, because registration accepts a native
 * directory grant. Throws {@link RootUnavailableError} (never a raw
 * system error) when the grant is missing or not a directory. No
 * lowercasing, no normalization of any kind beyond what the filesystem
 * itself answers: on a case-insensitive filesystem a case-variant alias
 * resolves to the same canonical string, on a case-sensitive one it is a
 * different root — the FS decides, not this function.
 */
export async function canonicalizeRoot(root: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(root);
  } catch {
    throw new RootUnavailableError();
  }
  const info = await stat(resolved).then(
    (result) => result,
    () => null,
  );
  if (info === null || !info.isDirectory()) throw new RootUnavailableError();
  return resolved;
}

/**
 * The default display name (ADR-0006 §1): the canonical root's basename,
 * separate from identity and routing. Callers validate it through the
 * protocol's disclosure guard before use — a basename is a path
 * fragment, and a pathological directory name could carry a disclosure
 * shape; failing closed there is the registry's rule, not a rename.
 */
export function defaultDisplayName(canonicalRoot: string): string {
  return basename(canonicalRoot);
}
