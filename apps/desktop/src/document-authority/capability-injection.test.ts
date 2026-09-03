import { describe, expect, it } from 'vitest';
import { originAllowsInjection, rewriteClientCapabilityHeader } from './capability-injection.ts';

/**
 * The injection policy's focused units (#246): the overwrite and strip
 * laws over pure header records — including the renderer-smuggle shapes
 * (mixed casings, doubled names) and the renderer-visible-secret law at
 * the unit tier (the rewrite touches ONE header name and adds ONE
 * value; the capability never rides a cookie or any other header).
 */

const CAPABILITY = 'a'.repeat(64);

describe('rewriteClientCapabilityHeader — after JavaScript request construction', () => {
  it('overwrites a renderer-set header in any casing with the live capability', () => {
    for (const rendererName of ['x-astroix-client', 'X-ASTROIX-CLIENT', 'X-Astroix-Client']) {
      const rewritten = rewriteClientCapabilityHeader(
        { 'Content-Type': 'application/json', [rendererName]: 'forged-renderer-value' },
        CAPABILITY,
      );
      expect(
        Object.keys(rewritten).filter((name) => name.toLowerCase() === 'x-astroix-client'),
      ).toEqual(['x-astroix-client']);
      expect(rewritten['x-astroix-client']).toBe(CAPABILITY);
      expect(rewritten['Content-Type']).toBe('application/json');
    }
  });

  it('collapses a doubled same-named pair (the smuggle shape) into the one canonical header', () => {
    const rewritten = rewriteClientCapabilityHeader(
      {
        'X-ASTROIX-CLIENT': 'forged-upper',
        'x-astroix-client': 'forged-lower',
      },
      CAPABILITY,
    );
    expect(Object.keys(rewritten)).toEqual(['x-astroix-client']);
    expect(rewritten['x-astroix-client']).toBe(CAPABILITY);
  });

  it('strips every casing when nothing is injectable — a forged value never leaves', () => {
    const rewritten = rewriteClientCapabilityHeader(
      { 'X-ASTROIX-CLIENT': 'forged-renderer-value', Accept: '*/*' },
      null,
    );
    expect(rewritten).toEqual({ Accept: '*/*' });
  });

  it('treats an empty injectable as none (fail closed)', () => {
    const rewritten = rewriteClientCapabilityHeader({ 'x-astroix-client': 'forged' }, '');
    expect(rewritten).toEqual({});
  });

  it('never touches any other header — the capability is header-only, never a cookie', () => {
    const headers = {
      Host: 'a.localhost:4321',
      Cookie: '__astroix_host=secret-host-cookie; theme=dark',
      'User-Agent': 'Mozilla/5.0 (Macintosh)',
      Accept: '*/*',
    };
    const rewritten = rewriteClientCapabilityHeader(headers, CAPABILITY);
    expect(rewritten).toEqual({ ...headers, 'x-astroix-client': CAPABILITY });
    // The input is never mutated.
    expect(headers).toEqual({
      Host: 'a.localhost:4321',
      Cookie: '__astroix_host=secret-host-cookie; theme=dark',
      'User-Agent': 'Mozilla/5.0 (Macintosh)',
      Accept: '*/*',
    });
  });
});

describe('originAllowsInjection — exact owned-origin membership only', () => {
  const owned = new Set(['http://a.localhost:4321']);

  it('admits the exact origin, any URL spelling of it', () => {
    expect(originAllowsInjection('http://a.localhost:4321/', owned)).toBe(true);
    expect(originAllowsInjection('http://A.LOCALHOST:4321/__astroix/api/v1/', owned)).toBe(true);
    expect(originAllowsInjection('http://a.localhost:4321/x?y=z#frag', owned)).toBe(true);
  });

  it('refuses every lookalike — other hosts, ports, schemes, suffixes — and unparseable URLs', () => {
    expect(originAllowsInjection('http://evil.localhost:4321/', owned)).toBe(false);
    expect(originAllowsInjection('http://a.localhost:4322/', owned)).toBe(false);
    expect(originAllowsInjection('https://a.localhost:4321/', owned)).toBe(false);
    expect(originAllowsInjection('http://aa.localhost:4321/', owned)).toBe(false);
    expect(originAllowsInjection('not a url', owned)).toBe(false);
  });
});
