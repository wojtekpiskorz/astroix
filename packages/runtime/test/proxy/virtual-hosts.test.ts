import { describe, expect, it } from 'vitest';
import {
  classifyRequestTarget,
  isReservedPath,
  LISTENER_REJECTION_STATUS,
  launcherOrigin,
  parseHostHeader,
  projectHostname,
  projectOrigin,
} from '../../origin/virtual-hosts.ts';

/**
 * The pure admission-classification matrix (#233 focused tests): the
 * strict Host parse (malformed, duplicate, trailing-dot, port shapes,
 * case-insensitive matching) and the request-target classification
 * (reserved namespace, natural targets verbatim, absolute-form,
 * ambiguous encodings). The end-to-end legs over real sockets live in
 * `origin-listener.test.ts`.
 */

const PORT = 4405;

describe('parseHostHeader', () => {
  it('accepts the bare launcher hostname and its case-insensitive variants', () => {
    expect(parseHostHeader({ value: 'launcher.localhost', count: 1, expectedPort: PORT })).toEqual({
      kind: 'host',
      hostname: 'launcher.localhost',
    });
    expect(parseHostHeader({ value: 'LAUNCHER.LOCALHOST', count: 1, expectedPort: PORT })).toEqual({
      kind: 'host',
      hostname: 'launcher.localhost',
    });
  });

  it('accepts a port only when it is exactly the listener port', () => {
    expect(
      parseHostHeader({ value: `launcher.localhost:${PORT}`, count: 1, expectedPort: PORT }),
    ).toEqual({
      kind: 'host',
      hostname: 'launcher.localhost',
    });
    expect(
      parseHostHeader({ value: 'launcher.localhost:9999', count: 1, expectedPort: PORT }),
    ).toEqual({ kind: 'rejected', reason: 'host-port-mismatch' });
  });

  it('rejects a missing or duplicated Host header', () => {
    expect(parseHostHeader({ value: undefined, count: 0, expectedPort: PORT })).toEqual({
      kind: 'rejected',
      reason: 'missing-host',
    });
    expect(parseHostHeader({ value: 'a.localhost', count: 2, expectedPort: PORT })).toEqual({
      kind: 'rejected',
      reason: 'duplicate-host',
    });
  });

  it('rejects the trailing-dot variant as a distinct DNS name', () => {
    expect(parseHostHeader({ value: 'launcher.localhost.', count: 1, expectedPort: PORT })).toEqual(
      {
        kind: 'rejected',
        reason: 'trailing-dot-host',
      },
    );
    expect(
      parseHostHeader({ value: `launcher.localhost.:${PORT}`, count: 1, expectedPort: PORT }),
    ).toEqual({ kind: 'rejected', reason: 'trailing-dot-host' });
  });

  it('rejects structurally malformed values', () => {
    for (const value of [
      '',
      ' launcher.localhost',
      'launcher.localhost ',
      'launch er.localhost',
      '.localhost',
      'a..localhost',
      'launcher::1',
      'launcher.localhost:',
      'launcher.localhost:4a40',
      'launcher.localhost:4405:x',
      'launcher%2elocalhost',
      '[::1]',
      '/etc/passwd',
    ]) {
      expect(parseHostHeader({ value, count: 1, expectedPort: PORT })).toEqual({
        kind: 'rejected',
        reason: 'malformed-host',
      });
    }
  });

  it('keeps well-formed foreign names parseable so the router, not the parser, refuses them', () => {
    // A DNS-rebinding domain and an unrelated .localhost name are
    // structurally fine — rejection is "not in the vocabulary" (404),
    // never a parse accident.
    expect(parseHostHeader({ value: 'rebind.example', count: 1, expectedPort: PORT })).toEqual({
      kind: 'host',
      hostname: 'rebind.example',
    });
    expect(parseHostHeader({ value: 'nobody.localhost', count: 1, expectedPort: PORT })).toEqual({
      kind: 'host',
      hostname: 'nobody.localhost',
    });
  });
});

describe('classifyRequestTarget', () => {
  it('classifies the reserved namespace root and everything below it', () => {
    expect(classifyRequestTarget('/__astroix')).toEqual({ kind: 'reserved' });
    expect(classifyRequestTarget('/__astroix/')).toEqual({ kind: 'reserved' });
    expect(classifyRequestTarget('/__astroix/app/')).toEqual({ kind: 'reserved' });
    expect(classifyRequestTarget('/__astroix/api/v1/x?y=1')).toEqual({ kind: 'reserved' });
  });

  it('keeps a lookalike segment natural', () => {
    expect(classifyRequestTarget('/__astroixfoo')).toEqual({
      kind: 'natural',
      target: '/__astroixfoo',
    });
    expect(classifyRequestTarget('/__astroixfoo/x')).toEqual({
      kind: 'natural',
      target: '/__astroixfoo/x',
    });
  });

  it('returns natural targets verbatim — path, resolved base, and query untouched', () => {
    expect(classifyRequestTarget('/')).toEqual({ kind: 'natural', target: '/' });
    expect(classifyRequestTarget('/docs/some/page?token=abc&x=1')).toEqual({
      kind: 'natural',
      target: '/docs/some/page?token=abc&x=1',
    });
    expect(classifyRequestTarget('/foo%20bar/baz?q=%2F')).toEqual({
      kind: 'natural',
      target: '/foo%20bar/baz?q=%2F',
    });
  });

  it('rejects absolute-form and asterisk-form targets', () => {
    expect(classifyRequestTarget('http://launcher.localhost:4405/')).toEqual({
      kind: 'rejected',
      reason: 'absolute-form-target',
    });
    expect(classifyRequestTarget('https://evil.example/x')).toEqual({
      kind: 'rejected',
      reason: 'absolute-form-target',
    });
    expect(classifyRequestTarget('*')).toEqual({
      kind: 'rejected',
      reason: 'asterisk-form-target',
    });
  });

  it('rejects malformed targets — empty, fragment, non-path, undecodable', () => {
    expect(classifyRequestTarget(undefined)).toEqual({
      kind: 'rejected',
      reason: 'malformed-target',
    });
    expect(classifyRequestTarget('')).toEqual({ kind: 'rejected', reason: 'malformed-target' });
    expect(classifyRequestTarget('/x#f')).toEqual({ kind: 'rejected', reason: 'malformed-target' });
    expect(classifyRequestTarget('x/1')).toEqual({ kind: 'rejected', reason: 'malformed-target' });
    expect(classifyRequestTarget('/%zz')).toEqual({ kind: 'rejected', reason: 'malformed-target' });
    expect(classifyRequestTarget('/%ff%fe')).toEqual({
      kind: 'rejected',
      reason: 'malformed-target',
    });
  });

  it('rejects encodings whose decoded form disagrees about the reserved boundary', () => {
    expect(classifyRequestTarget('/__astroix%2Fapp')).toEqual({
      kind: 'rejected',
      reason: 'ambiguous-reserved-encoding',
    });
    expect(classifyRequestTarget('/%5f%5fastroix/app')).toEqual({
      kind: 'rejected',
      reason: 'ambiguous-reserved-encoding',
    });
    // agreement in the natural direction stays natural
    expect(classifyRequestTarget('/foo%2fbar')).toEqual({ kind: 'natural', target: '/foo%2fbar' });
  });

  it('rejects backslash boundaries — WHATWG consumers treat \\ as /, so a boundary that flips under that normalization is ambiguous', () => {
    expect(classifyRequestTarget('/__astroix\\foo')).toEqual({
      kind: 'rejected',
      reason: 'ambiguous-reserved-encoding',
    });
    expect(classifyRequestTarget('/__astroix%5Cfoo')).toEqual({
      kind: 'rejected',
      reason: 'ambiguous-reserved-encoding',
    });
    expect(classifyRequestTarget('/%5f%5fastroix\\app')).toEqual({
      kind: 'rejected',
      reason: 'ambiguous-reserved-encoding',
    });
    // a backslash away from the reserved prefix flips nothing — forwarded verbatim
    expect(classifyRequestTarget('/foo\\bar')).toEqual({ kind: 'natural', target: '/foo\\bar' });
    expect(classifyRequestTarget('/__astroixx\\foo')).toEqual({
      kind: 'natural',
      target: '/__astroixx\\foo',
    });
  });
});

describe('vocabulary', () => {
  it('derives the virtual hosts and published origins', () => {
    expect(projectHostname('abcdefghijklmnopqrstuvwxyz')).toBe(
      'abcdefghijklmnopqrstuvwxyz.localhost',
    );
    expect(launcherOrigin(4405)).toBe('http://launcher.localhost:4405');
    expect(projectOrigin('abcdefghijklmnopqrstuvwxy2', 4405)).toBe(
      'http://abcdefghijklmnopqrstuvwxy2.localhost:4405',
    );
  });

  it('maps every refusal to its listener status — retired stays 421, unknown 404, malformed-class 400', () => {
    expect(LISTENER_REJECTION_STATUS['retired-host']).toBe(421);
    expect(LISTENER_REJECTION_STATUS['unknown-host']).toBe(404);
    const malformedClass = [
      'missing-host',
      'duplicate-host',
      'malformed-host',
      'trailing-dot-host',
      'host-port-mismatch',
      'absolute-form-target',
      'asterisk-form-target',
      'malformed-target',
      'ambiguous-reserved-encoding',
    ] as const;
    for (const reason of malformedClass) {
      expect(LISTENER_REJECTION_STATUS[reason]).toBe(400);
    }
  });

  it('answers the reserved-prefix predicate', () => {
    expect(isReservedPath('/__astroix')).toBe(true);
    expect(isReservedPath('/__astroix/')).toBe(true);
    expect(isReservedPath('/__astroix/app')).toBe(true);
    expect(isReservedPath('/__astroixapp')).toBe(false);
    expect(isReservedPath('/')).toBe(false);
  });
});
