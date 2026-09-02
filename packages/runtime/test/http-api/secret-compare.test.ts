import { describe, expect, it } from 'vitest';
import { sameSecret } from '../../api/http/secret-compare.ts';

/**
 * The surface's one timing-safe secret comparator (#234): digest-fixed
 * and length-agnostic — unequal-length secrets compare without throwing
 * (the raw `timingSafeEqual` would), and every disagreement is false.
 */

describe('sameSecret', () => {
  it('accepts exactly the same secret', () => {
    expect(sameSecret('a'.repeat(64), 'a'.repeat(64))).toBe(true);
  });

  it('rejects any disagreement, including length mismatches, without throwing', () => {
    expect(sameSecret('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    expect(sameSecret('a'.repeat(64), 'a'.repeat(63))).toBe(false);
    expect(sameSecret('a'.repeat(64), `${'a'.repeat(63)}b`)).toBe(false);
    expect(sameSecret('', '')).toBe(true); // two empty secrets ARE the same secret
  });
});
