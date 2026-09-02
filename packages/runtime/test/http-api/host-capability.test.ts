import { LIMITS } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_COOKIE_NAME,
  capabilityFromCookieHeader,
  createHostCapabilityGrants,
  hostCapabilitySetCookie,
  mintHostCapability,
  parseCookieHeader,
} from '../../api/http/host-capability.ts';
import { KEY_A } from './fixtures.ts';

/**
 * The host capability law (#234; ADR-0006 §3): 256-bit mints, one
 * capability per host (launcher and every project activation differ),
 * timing-safe verification, revocation, the HttpOnly host-only cookie
 * shape, and the cookie-header extraction with duplicate-name refusal.
 */

describe('capability minting', () => {
  it('mints 256-bit values as 64-char lowercase hex, never repeating', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      const capability = mintHostCapability();
      expect(capability).toMatch(/^[0-9a-f]{64}$/);
      expect(capability.length).toBe((LIMITS.requestCapabilityBits / 8) * 2);
      expect(seen.has(capability)).toBe(false);
      seen.add(capability);
    }
  });
});

describe('the capability cookie shape (the cookie law, ADR-0006 §3)', () => {
  it('builds a host-only HttpOnly cookie with Path=/ and nothing else', () => {
    const cookie = hostCapabilitySetCookie('a'.repeat(64));
    expect(cookie).toBe(`__astroix_host=${'a'.repeat(64)}; Path=/; HttpOnly`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    // host-only: NO Domain attribute; no Secure (loopback http); no JS-visible leak shape
    expect(cookie.toLowerCase()).not.toContain('domain=');
    expect(cookie.toLowerCase()).not.toContain('samesite');
    expect(cookie.toLowerCase()).not.toContain('secure');
  });

  it('names the cookie __astroix_host — the one place the name exists', () => {
    expect(CAPABILITY_COOKIE_NAME).toBe('__astroix_host');
  });
});

describe('cookie header parsing and extraction', () => {
  it('parses a cookie jar with spacing tolerance', () => {
    const jar = parseCookieHeader('session=keep;  __astroix_host=secret ; other=1');
    expect(jar.values.session).toBe('keep');
    expect(jar.values.__astroix_host).toBe('secret');
    expect(jar.values.other).toBe('1');
    expect(jar.counts.__astroix_host).toBe(1);
  });

  it('extracts the capability — present, absent, or ambiguous on a duplicate name', () => {
    expect(capabilityFromCookieHeader('__astroix_host=secret')).toEqual({
      kind: 'present',
      value: 'secret',
    });
    expect(capabilityFromCookieHeader('session=keep')).toEqual({ kind: 'absent' });
    expect(capabilityFromCookieHeader(undefined)).toEqual({ kind: 'absent' });
    expect(capabilityFromCookieHeader('')).toEqual({ kind: 'absent' });
    expect(capabilityFromCookieHeader('__astroix_host=one; x=1; __astroix_host=two')).toEqual({
      kind: 'ambiguous',
    });
  });
});

describe('the host capability grants table', () => {
  it('verifies only the current capability of the exact host — different hosts get different capabilities', () => {
    const grants = createHostCapabilityGrants();
    const launcher = grants.mint({ host: 'launcher' });
    const project = grants.mint({ host: 'project', projectKey: KEY_A });
    expect(launcher).not.toBe(project);
    expect(grants.verify(launcher, { host: 'launcher' })).toBe(true);
    expect(grants.verify(project, { host: 'project', projectKey: KEY_A })).toBe(true);
    // cross-host: a launcher capability never authorizes the project host, nor the reverse
    expect(grants.verify(launcher, { host: 'project', projectKey: KEY_A })).toBe(false);
    expect(grants.verify(project, { host: 'launcher' })).toBe(false);
    // wrong / missing values fail closed
    expect(grants.verify('f'.repeat(64), { host: 'launcher' })).toBe(false);
    expect(grants.verify(undefined, { host: 'launcher' })).toBe(false);
    expect(grants.verify('', { host: 'launcher' })).toBe(false);
  });

  it('refuses the stale capability after re-mint — the A-to-B-to-A host-cookie rotation', () => {
    const grants = createHostCapabilityGrants();
    const before = grants.mint({ host: 'project', projectKey: KEY_A });
    expect(grants.verify(before, { host: 'project', projectKey: KEY_A })).toBe(true);
    const after = grants.mint({ host: 'project', projectKey: KEY_A });
    expect(after).not.toBe(before);
    expect(grants.verify(before, { host: 'project', projectKey: KEY_A })).toBe(false);
    expect(grants.verify(after, { host: 'project', projectKey: KEY_A })).toBe(true);
  });

  it('revokes fail closed — a revoked capability never verifies again', () => {
    const grants = createHostCapabilityGrants();
    const launcher = grants.mint({ host: 'launcher' });
    grants.revoke({ host: 'launcher' });
    expect(grants.verify(launcher, { host: 'launcher' })).toBe(false);
    expect(grants.current({ host: 'launcher' })).toBeNull();
  });

  it('keeps a similar-length forgery from verifying (digest comparison, not string equality shape)', () => {
    const grants = createHostCapabilityGrants();
    const capability = grants.mint({ host: 'launcher' });
    const forgery =
      `${capability.slice(0, 63)}0` === capability
        ? `${capability.slice(0, 63)}1`
        : `${capability.slice(0, 63)}0`;
    expect(grants.verify(forgery, { host: 'launcher' })).toBe(false);
  });
});
