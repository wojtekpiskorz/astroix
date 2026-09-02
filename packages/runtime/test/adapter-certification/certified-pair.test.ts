import { describe, expect, it } from 'vitest';
import {
  CERTIFIED_PAIRS,
  formatPair,
  isCertifiedPair,
  PAIR_CERTIFICATION_CONTRACT,
  uncertifiedPairError,
} from '../../astro-project-adapter/certified-pair';

/**
 * Certified-pair semantics (#225, ruling #206): certification is a set of
 * EXACT pairs — never a range. Exact-string membership only; any drift,
 * including range-satisfying drift, is uncertified; the rejection carries
 * detected, certified, and the rejected contract.
 */

describe('CERTIFIED_PAIRS', () => {
  it('records exactly one certified pair: astro@7.2.10 + vite@8.2.2', () => {
    expect(CERTIFIED_PAIRS).toEqual([{ astro: '7.2.10', vite: '8.2.2' }]);
  });
});

describe('isCertifiedPair', () => {
  it('accepts the exact certified pair', () => {
    expect(isCertifiedPair({ astro: '7.2.10', vite: '8.2.2' })).toBe(true);
  });

  it('rejects astro patch drift even though it satisfies the 7.2.x range', () => {
    expect(isCertifiedPair({ astro: '7.2.11', vite: '8.2.2' })).toBe(false);
  });

  it('rejects astro minor drift, major drift, and vite drift', () => {
    expect(isCertifiedPair({ astro: '7.3.0', vite: '8.2.2' })).toBe(false);
    expect(isCertifiedPair({ astro: '8.0.0', vite: '8.2.2' })).toBe(false);
    expect(isCertifiedPair({ astro: '7.2.10', vite: '8.2.1' })).toBe(false);
    expect(isCertifiedPair({ astro: '7.2.10', vite: '8.3.0' })).toBe(false);
  });

  it('rejects prerelease spellings of the certified versions', () => {
    expect(isCertifiedPair({ astro: '7.2.10-beta.1', vite: '8.2.2' })).toBe(false);
    expect(isCertifiedPair({ astro: '7.2.10', vite: '8.2.2-rc.0' })).toBe(false);
  });

  it('checks membership against the supplied set, not the default', () => {
    const future = [{ astro: '7.3.1', vite: '8.3.0' }];
    expect(isCertifiedPair({ astro: '7.3.1', vite: '8.3.0' }, future)).toBe(true);
    expect(isCertifiedPair({ astro: '7.2.10', vite: '8.2.2' }, future)).toBe(false);
  });
});

describe('formatPair', () => {
  it('renders the diagnostic form', () => {
    expect(formatPair({ astro: '7.2.10', vite: '8.2.2' })).toBe('astro@7.2.10 + vite@8.2.2');
  });
});

describe('uncertifiedPairError', () => {
  it('reports detected pair, certified pairs, and the rejected contract', () => {
    const error = uncertifiedPairError({ astro: '7.2.11', vite: '8.2.1' });
    expect(error.code).toBe('uncertified-pair');
    expect(error.message).toBe(
      'AstroProjectAdapter compatibility rejection: detected astro@7.2.11 + vite@8.2.1; certified pairs: astro@7.2.10 + vite@8.2.2; failed contract: exact Astro/Vite pair certification must pass before project config executes',
    );
    expect(error.details).toEqual({
      detected: { astro: '7.2.11', vite: '8.2.1' },
      certified: [{ astro: '7.2.10', vite: '8.2.2' }],
      rejectedContract: PAIR_CERTIFICATION_CONTRACT,
    });
  });

  it('names an empty certified set as none rather than an empty list', () => {
    const error = uncertifiedPairError({ astro: '7.2.10', vite: '8.2.2' }, []);
    expect(error.message).toContain('certified pairs: none');
    expect(error.details).toEqual({
      detected: { astro: '7.2.10', vite: '8.2.2' },
      certified: [],
      rejectedContract: PAIR_CERTIFICATION_CONTRACT,
    });
  });
});
