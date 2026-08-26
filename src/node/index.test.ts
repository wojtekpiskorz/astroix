import { describe, expect, it } from 'vitest';
import astroix from './index';

describe('astroix integration entry', () => {
  it('exposes a named Astro integration', () => {
    expect(astroix().name).toBe('astroix');
  });
});
