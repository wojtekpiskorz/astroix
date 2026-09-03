import { describe, expect, it } from 'vitest';
import {
  CLIENT_INJECTION_FILTER_URLS,
  type ClientCapabilityRequestDetails,
  installClientCapabilityInjection,
  type WebRequestListenerSeam,
} from './web-request-injection.ts';

/**
 * The webRequest adapter's focused units (#246): a recording fake of
 * the structural seam (the real `session.webRequest` satisfies it
 * unchanged), driven with renderer-shaped details — the forged-header
 * overwrite, the foreign-origin and unbound-document strip laws, the
 * HTTP(S)-only filter, and detach. The real-Electron proof is the
 * `e2e/desktop` lane; these pin the adapter's own decisions.
 */

const CAPABILITY = 'b'.repeat(64);
const OWNED_ORIGIN = 'http://a.localhost:4321';

/** The recording fake: one registration slot, detach included. */
function fakeWebRequest(): {
  seam: WebRequestListenerSeam;
  filter(): { urls: readonly string[] } | null;
  dispatch(details: ClientCapabilityRequestDetails): Record<string, string | string[]> | undefined;
  detached(): boolean;
} {
  let registration: {
    filter: { urls: readonly string[] };
    listener:
      | ((
          details: ClientCapabilityRequestDetails,
          callback: (response: { requestHeaders?: Record<string, string | string[]> }) => void,
        ) => void)
      | null;
  } | null = null;
  return {
    seam: {
      onBeforeSendHeaders: (filter, listener) => {
        registration = { filter, listener };
      },
    },
    filter: () => registration?.filter ?? null,
    dispatch: (details) => {
      if (registration === null || registration.listener === null) return undefined;
      let response: { requestHeaders?: Record<string, string | string[]> } | undefined;
      registration.listener(details, (settled) => {
        response = settled;
      });
      return response?.requestHeaders;
    },
    detached: () => registration !== null && registration.listener === null,
  };
}

describe('installClientCapabilityInjection — the after-construction seam', () => {
  it('registers one listener over the HTTP(S)-only filter', () => {
    const webRequest = fakeWebRequest();
    installClientCapabilityInjection({
      webRequest: webRequest.seam,
      ownedOrigins: [OWNED_ORIGIN],
      authority: { injectableCapability: () => null },
    });
    expect(webRequest.filter()?.urls).toEqual(CLIENT_INJECTION_FILTER_URLS);
    expect(CLIENT_INJECTION_FILTER_URLS).toEqual(['http://*/*', 'https://*/*']);
  });

  it('injects the live capability over a renderer-forged header at the owned origin', () => {
    const webRequest = fakeWebRequest();
    installClientCapabilityInjection({
      webRequest: webRequest.seam,
      ownedOrigins: [OWNED_ORIGIN],
      authority: { injectableCapability: (id) => (id === 7 ? CAPABILITY : null) },
    });
    const forwarded = webRequest.dispatch({
      url: `${OWNED_ORIGIN}/__astroix/api/v1/`,
      webContentsId: 7,
      resourceType: 'xhr',
      requestHeaders: {
        'X-ASTROIX-CLIENT': 'forged-renderer-value',
        Accept: 'application/json',
        // An array-valued header rides verbatim — the seam's real shape.
        'X-Multi-Value': ['one', 'two'],
      },
    });
    expect(forwarded).toEqual({
      'x-astroix-client': CAPABILITY,
      Accept: 'application/json',
      'X-Multi-Value': ['one', 'two'],
    });
  });

  it('strips the forged header at a foreign origin even with a live binding (no secret leak)', () => {
    const webRequest = fakeWebRequest();
    installClientCapabilityInjection({
      webRequest: webRequest.seam,
      ownedOrigins: [OWNED_ORIGIN],
      authority: { injectableCapability: () => CAPABILITY },
    });
    const forwarded = webRequest.dispatch({
      url: 'http://evil.example.com/collect',
      webContentsId: 7,
      requestHeaders: { 'x-astroix-client': 'forged-renderer-value' },
    });
    expect(forwarded).toEqual({});
  });

  it('strips the forged header when the document holds no live binding', () => {
    const webRequest = fakeWebRequest();
    installClientCapabilityInjection({
      webRequest: webRequest.seam,
      ownedOrigins: [OWNED_ORIGIN],
      authority: { injectableCapability: () => null },
    });
    const forwarded = webRequest.dispatch({
      url: `${OWNED_ORIGIN}/__astroix/api/v1/`,
      webContentsId: 7,
      requestHeaders: { 'X-Astroix-Client': 'forged-renderer-value', Accept: '*/*' },
    });
    expect(forwarded).toEqual({ Accept: '*/*' });
  });

  it('strips the forged header when the request carries no webContents identity', () => {
    const webRequest = fakeWebRequest();
    installClientCapabilityInjection({
      webRequest: webRequest.seam,
      ownedOrigins: [OWNED_ORIGIN],
      authority: { injectableCapability: () => CAPABILITY },
    });
    const forwarded = webRequest.dispatch({
      url: `${OWNED_ORIGIN}/some/resource`,
      requestHeaders: { 'x-astroix-client': 'forged-service-worker-value' },
    });
    expect(forwarded).toEqual({});
  });

  it('detaches by unregistering the listener', () => {
    const webRequest = fakeWebRequest();
    const injection = installClientCapabilityInjection({
      webRequest: webRequest.seam,
      ownedOrigins: [OWNED_ORIGIN],
      authority: { injectableCapability: () => CAPABILITY },
    });
    injection.detach();
    expect(webRequest.detached()).toBe(true);
    expect(
      webRequest.dispatch({
        url: `${OWNED_ORIGIN}/`,
        webContentsId: 7,
        requestHeaders: {},
      }),
    ).toBeUndefined();
  });
});
