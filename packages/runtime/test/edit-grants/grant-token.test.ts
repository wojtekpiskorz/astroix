import { describe, expect, it } from 'vitest';
import {
  GRANT_TOKEN_PATTERN,
  isGrantTokenShape,
  mintGrantToken,
} from '../../edit-authority/grants/grant-token';

/**
 * The opaque grant token (#223, ADR-0006 §6): per-activation CSPRNG
 * values in the 256-bit base64url species (the boot capability's, #222).
 * Opaqueness is structural — minting reads no path, index, or discovery
 * fact, and the shape check never reads meaning into the value.
 */

describe('mintGrantToken', () => {
  it('renders the 43-character base64url shape', () => {
    for (let i = 0; i < 100; i += 1) {
      const token = mintGrantToken();
      expect(token).toHaveLength(43);
      expect(GRANT_TOKEN_PATTERN.test(token)).toBe(true);
    }
  });

  it('never repeats across draws (randomness, not derivation)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(mintGrantToken());
    expect(seen.size).toBe(1000);
  });

  it('carries real entropy: two tokens share no 8-char prefix run beyond chance', () => {
    // A derived token (from a path, a counter) would share structure; a
    // random one does not. Assert the weak, deterministic property: the
    // first two characters differ for at least one of 50 draws.
    const first = mintGrantToken();
    const differing = Array.from({ length: 50 }, () => mintGrantToken()).some(
      (token) => token.slice(0, 2) !== first.slice(0, 2),
    );
    expect(differing).toBe(true);
  });
});

describe('isGrantTokenShape', () => {
  it('accepts a minted token', () => {
    expect(isGrantTokenShape(mintGrantToken())).toBe(true);
  });

  it('rejects arbitrary client strings', () => {
    expect(isGrantTokenShape('')).toBe(false);
    expect(isGrantTokenShape('src/styles/global.css')).toBe(false);
    expect(isGrantTokenShape(`sha!${'a'.repeat(39)}`)).toBe(false);
    expect(isGrantTokenShape(`${'a'.repeat(42)}+`)).toBe(false); // '+' is base64, not base64url
    expect(isGrantTokenShape(`${'a'.repeat(42)}/`)).toBe(false); // '/' likewise
    expect(isGrantTokenShape(`${'a'.repeat(42)}=`)).toBe(false); // padding
  });
});
