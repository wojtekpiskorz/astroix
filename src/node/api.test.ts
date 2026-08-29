import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isCrossOriginTraffic } from './api';

describe('isCrossOriginTraffic', () => {
  function withSite(secFetchSite: string | undefined): IncomingMessage {
    const headers: Record<string, string> = {};
    if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite;
    return { headers } as IncomingMessage;
  }

  it('serves builder-origin traffic: same-origin, none, and no header at all', () => {
    expect(isCrossOriginTraffic(withSite('same-origin'))).toBe(false);
    expect(isCrossOriginTraffic(withSite('none'))).toBe(false);
    expect(isCrossOriginTraffic(withSite(undefined))).toBe(false);
  });

  it('rejects anything a browser marks as same-site or cross-site', () => {
    expect(isCrossOriginTraffic(withSite('same-site'))).toBe(true);
    expect(isCrossOriginTraffic(withSite('cross-site'))).toBe(true);
  });
});
