import { describe, expect, it } from 'vitest';
import {
  contentTypeIsJson,
  duplicatedSecurityHeader,
  headerEvidence,
  SECURITY_RELEVANT_HEADERS,
} from '../../api/http/security-headers.ts';

/**
 * Security-relevant header evidence (#234; ADR-0006 §7 "Reject …
 * duplicate security-relevant headers", "JSON content"): duplicates are
 * counted from the raw pairs (never a joined value), and the content
 * type is exactly `application/json`.
 */

describe('header evidence over raw pairs', () => {
  it('reads counts and single values from the raw pairs, case-insensitively', () => {
    const evidence = headerEvidence([
      'Host',
      'launcher.localhost:4321',
      'ORIGIN',
      'http://launcher.localhost:4321',
      'X-Astroix-Request',
      '1',
      'Accept',
      '*/*',
    ]);
    expect(evidence.counts.host).toBe(1);
    expect(evidence.counts.origin).toBe(1);
    expect(evidence.counts['x-astroix-request']).toBe(1);
    expect(evidence.values.host).toBe('launcher.localhost:4321');
    expect(evidence.values.origin).toBe('http://launcher.localhost:4321');
    expect(evidence.values['x-astroix-request']).toBe('1');
    expect(evidence.counts.accept).toBeUndefined(); // not security-relevant: not tracked
  });

  it('keeps every security-relevant name in the tracked set', () => {
    expect(SECURITY_RELEVANT_HEADERS).toEqual([
      'host',
      'origin',
      'cookie',
      'content-type',
      'content-length',
      'sec-fetch-site',
      'x-astroix-request',
      'x-astroix-client',
    ]);
  });
});

describe('duplicate security-relevant headers', () => {
  it('detects a duplicated name from raw pairs — a comma-join can never hide it', () => {
    expect(
      duplicatedSecurityHeader(headerEvidence(['Origin', 'http://a', 'Origin', 'http://b'])),
    ).toBe('origin');
    expect(duplicatedSecurityHeader(headerEvidence(['Cookie', 'a=1', 'Cookie', 'b=2']))).toBe(
      'cookie',
    );
    expect(
      duplicatedSecurityHeader(
        headerEvidence(['X-Astroix-Client', 'one', 'x-astroix-client', 'two']),
      ),
    ).toBe('x-astroix-client');
    expect(
      duplicatedSecurityHeader(headerEvidence(['Content-Length', '1', 'Content-Length', '2'])),
    ).toBe('content-length');
    expect(
      duplicatedSecurityHeader(
        headerEvidence(['Sec-Fetch-Site', 'same-origin', 'sec-fetch-site', 'none']),
      ),
    ).toBe('sec-fetch-site');
    expect(
      duplicatedSecurityHeader(
        headerEvidence(['X-Astroix-Request', '1', 'X-Astroix-Request', '1']),
      ),
    ).toBe('x-astroix-request');
    expect(duplicatedSecurityHeader(headerEvidence(['Host', 'a', 'Host', 'b']))).toBe('host');
  });

  it('reports no duplicate for single occurrences and for duplicated non-security names', () => {
    expect(
      duplicatedSecurityHeader(headerEvidence(['Host', 'a', 'Accept', 'x', 'Accept', 'y'])),
    ).toBeNull();
    expect(duplicatedSecurityHeader(headerEvidence(['Origin', 'one']))).toBeNull();
  });
});

describe('the JSON content-type gate', () => {
  it('accepts exactly application/json, with or without charset=utf-8, case-insensitively', () => {
    expect(contentTypeIsJson('application/json')).toBe(true);
    expect(contentTypeIsJson('application/json; charset=utf-8')).toBe(true);
    expect(contentTypeIsJson('Application/JSON')).toBe(true);
    expect(contentTypeIsJson('APPLICATION/JSON; CHARSET=UTF-8')).toBe(true);
    expect(contentTypeIsJson('application/json ; charset=utf-8')).toBe(true);
  });

  it('rejects every other media type, parameter, and absence (ADR-0006 §7 "JSON content")', () => {
    expect(contentTypeIsJson(undefined)).toBe(false);
    expect(contentTypeIsJson('')).toBe(false);
    expect(contentTypeIsJson('text/plain')).toBe(false);
    expect(contentTypeIsJson('application/json-patch+json')).toBe(false);
    expect(contentTypeIsJson('application/json; charset=iso-8859-1')).toBe(false);
    expect(contentTypeIsJson('application/json; boundary=x')).toBe(false);
    expect(contentTypeIsJson('text/json')).toBe(false);
  });
});
