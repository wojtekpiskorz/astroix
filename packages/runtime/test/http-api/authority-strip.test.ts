import { describe, expect, it } from 'vitest';
import { stripCapabilityCookie, stripControlAuthority } from '../../api/http/authority-strip.ts';

/**
 * The canonical authority strip (#234; ADR-0006 §3 "strips it before
 * forwarding either request to the managed Astro/Vite server"): the
 * host-capability cookie and the injected client-capability header are
 * removed from everything handed onward — HTTP stream shapes and raw
 * HMR upgrade handshake shapes alike — while every other header passes
 * through untouched. The live wiring into the proxy path is #246's;
 * THIS is the one definition both transports call.
 */

const SECRET = 'f'.repeat(64);

describe('the capability-cookie strip', () => {
  it('drops the capability cookie and keeps every other cookie', () => {
    expect(stripCapabilityCookie(`session=keep; __astroix_host=${SECRET}; other=1`)).toBe(
      'session=keep; other=1',
    );
    expect(stripCapabilityCookie(`__astroix_host=${SECRET}; session=keep`)).toBe('session=keep');
    expect(stripCapabilityCookie(`session=keep; __astroix_host=${SECRET}`)).toBe('session=keep');
  });

  it('drops the whole Cookie header when the capability was the only cookie', () => {
    expect(stripCapabilityCookie(`__astroix_host=${SECRET}`)).toBeUndefined();
    expect(stripCapabilityCookie(` __astroix_host=${SECRET} `)).toBeUndefined();
  });

  it('leaves a cookie header without the capability untouched', () => {
    expect(stripCapabilityCookie('session=keep; theme=dark')).toBe('session=keep; theme=dark');
  });
});

describe('the header-set strip — the HTTP stream shape', () => {
  it('removes the client-capability header and filters the cookie; everything else verbatim', () => {
    const forwarded = stripControlAuthority({
      host: 'abc.localhost:4408',
      'content-type': 'text/html',
      cookie: `session=keep; __astroix_host=${SECRET}`,
      'x-astroix-client': 'client-secret',
      'cache-control': 'no-cache',
    });
    expect(forwarded).toEqual({
      host: 'abc.localhost:4408',
      'content-type': 'text/html',
      cookie: 'session=keep',
      'cache-control': 'no-cache',
    });
    expect(forwarded['x-astroix-client']).toBeUndefined();
    expect(JSON.stringify(forwarded)).not.toContain(SECRET);
    expect(JSON.stringify(forwarded)).not.toContain('client-secret');
  });

  it('drops the cookie header outright when only the capability rode it', () => {
    const forwarded = stripControlAuthority({ cookie: `__astroix_host=${SECRET}` });
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded).toEqual({});
  });

  it('does not mutate its input — the original set still carries what it carried', () => {
    const input = { cookie: `__astroix_host=${SECRET}`, 'x-astroix-client': 'client-secret' };
    stripControlAuthority(input);
    expect(input.cookie).toBe(`__astroix_host=${SECRET}`);
    expect(input['x-astroix-client']).toBe('client-secret');
  });
});

describe('the header-set strip — the raw HMR upgrade shape', () => {
  it('strips control authority while preserving the Vite HMR handshake headers byte-for-byte', () => {
    // the header view F1's tunnel forwards for a natural-path HMR
    // upgrade: URL token, Host, Origin, subprotocol, and the cookie the
    // browser attached (Path=/ reaches outside the reserved namespace)
    const forwarded = stripControlAuthority({
      host: 'abc.localhost:4408',
      origin: 'http://abc.localhost:4408',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-protocol': 'vite-hmr',
      'sec-websocket-key': 'dGhlIHRva2VuIHZpdGUgbWludGVk',
      'sec-websocket-version': '13',
      cookie: `__astroix_host=${SECRET}; vite-session=keep`,
      'x-astroix-client': 'client-secret',
    });
    expect(forwarded.cookie).toBe('vite-session=keep');
    expect(forwarded['x-astroix-client']).toBeUndefined();
    expect(forwarded['sec-websocket-protocol']).toBe('vite-hmr');
    expect(forwarded['sec-websocket-key']).toBe('dGhlIHRva2VuIHZpdGUgbWludGVk');
    expect(forwarded.host).toBe('abc.localhost:4408');
    expect(forwarded.origin).toBe('http://abc.localhost:4408');
  });

  it('handles the array-valued cookie join some clients produce', () => {
    const forwarded = stripControlAuthority({
      cookie: [`__astroix_host=${SECRET}`, 'session=keep'],
    });
    expect(forwarded.cookie).toBe('session=keep');
  });
});
