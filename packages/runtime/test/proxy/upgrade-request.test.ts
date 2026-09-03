import { describe, expect, it } from 'vitest';
import { stripAuthorityFromRawPairs } from '../../api/http/authority-strip.ts';
import {
  reconstructUpgradeHandshake,
  validateUpgradeRequest,
} from '../../proxy/upgrade-request.ts';

/**
 * The upgrade admission and handshake-reconstruction focused tests
 * (#233): the RFC 6455 opening shape, the `vite-hmr` subprotocol gate,
 * the exact same-origin Origin, and the byte-true reassembly of the
 * client's handshake (original casing, order, duplicates visible) —
 * plus the raw-pair control-authority strip that feeds the
 * reconstruction (#338, ADR-0006 §3): F2's one definition decides the
 * drops, and every kept pair keeps its exact bytes and position.
 */

const ORIGIN = 'http://abcdefghijklmnopqrstuvwxyz.localhost:4405';

function openingHeaders(): Record<string, string> {
  return {
    Host: 'abcdefghijklmnopqrstuvwxyz.localhost:4405',
    Origin: ORIGIN,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Protocol': 'vite-hmr',
  };
}

describe('validateUpgradeRequest', () => {
  it('admits a well-formed vite-hmr opening from the project origin', () => {
    expect(
      validateUpgradeRequest({ method: 'GET', headers: openingHeaders(), expectedOrigin: ORIGIN }),
    ).toEqual({ kind: 'admitted' });
  });

  it('admits the subprotocol among several and matching header casing', () => {
    const headers = openingHeaders();
    headers['Sec-WebSocket-Protocol'] = 'json, Vite-HMR';
    headers.connection = 'keep-alive, Upgrade';
    expect(validateUpgradeRequest({ method: 'GET', headers, expectedOrigin: ORIGIN })).toEqual({
      kind: 'admitted',
    });
  });

  it('rejects non-GET and non-websocket openings', () => {
    expect(
      validateUpgradeRequest({ method: 'POST', headers: openingHeaders(), expectedOrigin: ORIGIN }),
    ).toEqual({ kind: 'rejected', reason: 'not-get-upgrade' });
    for (const reason of [
      'not-websocket-upgrade',
      'missing-websocket-key',
      'unsupported-websocket-version',
    ]) {
      const headers = openingHeaders();
      if (reason === 'not-websocket-upgrade') headers.Upgrade = 'h2c';
      if (reason === 'missing-websocket-key') delete headers['Sec-WebSocket-Key'];
      if (reason === 'unsupported-websocket-version') headers['Sec-WebSocket-Version'] = '8';
      expect(validateUpgradeRequest({ method: 'GET', headers, expectedOrigin: ORIGIN })).toEqual({
        kind: 'rejected',
        reason,
      });
    }
    const noConnection = openingHeaders();
    delete noConnection.Connection;
    expect(
      validateUpgradeRequest({ method: 'GET', headers: noConnection, expectedOrigin: ORIGIN }),
    ).toEqual({ kind: 'rejected', reason: 'not-websocket-upgrade' });
  });

  it('rejects a missing, foreign, or cross-project Origin', () => {
    const absent = openingHeaders();
    delete absent.Origin;
    expect(
      validateUpgradeRequest({ method: 'GET', headers: absent, expectedOrigin: ORIGIN }),
    ).toEqual({ kind: 'rejected', reason: 'missing-origin' });
    const foreign = openingHeaders();
    foreign.Origin = 'http://evil.example';
    expect(
      validateUpgradeRequest({ method: 'GET', headers: foreign, expectedOrigin: ORIGIN }),
    ).toEqual({ kind: 'rejected', reason: 'origin-mismatch' });
    const sibling = openingHeaders();
    sibling.Origin = 'http://abcdefghijklmnopqrstuvwxy2.localhost:4405';
    expect(
      validateUpgradeRequest({ method: 'GET', headers: sibling, expectedOrigin: ORIGIN }),
    ).toEqual({ kind: 'rejected', reason: 'origin-mismatch' });
  });

  it('rejects upgrades without the vite-hmr subprotocol — it is the only transparent WebSocket', () => {
    const absent = openingHeaders();
    delete absent['Sec-WebSocket-Protocol'];
    expect(
      validateUpgradeRequest({ method: 'GET', headers: absent, expectedOrigin: ORIGIN }),
    ).toEqual({ kind: 'rejected', reason: 'missing-hmr-subprotocol' });
    const other = openingHeaders();
    other['Sec-WebSocket-Protocol'] = 'chat, superchat';
    expect(
      validateUpgradeRequest({ method: 'GET', headers: other, expectedOrigin: ORIGIN }),
    ).toEqual({ kind: 'rejected', reason: 'missing-hmr-subprotocol' });
  });
});

describe('reconstructUpgradeHandshake', () => {
  it('reassembles the exact request line and header pairs — original casing, order, and duplicates', () => {
    const handshake = reconstructUpgradeHandshake({
      method: 'GET',
      url: '/?token=T0K3N-vite',
      httpVersion: '1.1',
      rawHeaders: [
        'Host',
        'abcdefghijklmnopqrstuvwxyz.localhost:4405',
        'Origin',
        ORIGIN,
        'Connection',
        'Upgrade',
        'Upgrade',
        'websocket',
        'Sec-WebSocket-Key',
        'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version',
        '13',
        'Sec-WebSocket-Protocol',
        'vite-hmr',
      ],
    });
    expect(handshake).toBe(
      [
        'GET /?token=T0K3N-vite HTTP/1.1',
        'Host: abcdefghijklmnopqrstuvwxyz.localhost:4405',
        `Origin: ${ORIGIN}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: vite-hmr',
        '',
        '',
      ].join('\r\n'),
    );
  });
});

describe('stripAuthorityFromRawPairs (the raw-pair leg of the control-authority strip)', () => {
  it('drops the client-capability pair in any casing and keeps every other pair byte-identical', () => {
    const kept = stripAuthorityFromRawPairs([
      'Host',
      'abcdefghijklmnopqrstuvwxyz.localhost:4405',
      'X-Astroix-Client',
      'cap-7f3a',
      'Sec-WebSocket-Key',
      'dGhlIHNhbXBsZSBub25jZQ==',
      'x-astroix-client',
      'cap-deadbeef',
      'Origin',
      ORIGIN,
    ]);
    expect(kept).toEqual([
      'Host',
      'abcdefghijklmnopqrstuvwxyz.localhost:4405',
      'Sec-WebSocket-Key',
      'dGhlIHNhbXBsZSBub25jZQ==',
      'Origin',
      ORIGIN,
    ]);
  });

  it('filters the capability cookie out of a Cookie line and drops the pair when nothing else rode it', () => {
    expect(stripAuthorityFromRawPairs(['Cookie', '__astroix_host=host-cap; theme=dark'])).toEqual([
      'Cookie',
      'theme=dark',
    ]);
    expect(stripAuthorityFromRawPairs(['Cookie', '__astroix_host=host-cap'])).toEqual([]);
  });

  it('cleans every cookie-cased spelling — distinct-case duplicates cannot smuggle one through', () => {
    expect(
      stripAuthorityFromRawPairs([
        'Cookie',
        '__astroix_host=host-cap; theme=dark',
        'COOKIE',
        '__astroix_host=host-cap',
      ]),
    ).toEqual(['Cookie', 'theme=dark']);
  });

  it('feeds the reconstruction: the handshake carries the authority in no casing and everything else exactly', () => {
    const forwarded = reconstructUpgradeHandshake({
      method: 'GET',
      url: '/?token=T0K3N-vite',
      httpVersion: '1.1',
      rawHeaders: stripAuthorityFromRawPairs([
        'Host',
        'abcdefghijklmnopqrstuvwxyz.localhost:4405',
        'Origin',
        ORIGIN,
        'X-Astroix-Client',
        'cap-7f3a',
        'Cookie',
        '__astroix_host=host-cap; theme=dark',
        'Sec-WebSocket-Key',
        'dGhlIHNhbXBsZSBub25jZQ==',
      ]),
    });
    expect(forwarded).toBe(
      [
        'GET /?token=T0K3N-vite HTTP/1.1',
        'Host: abcdefghijklmnopqrstuvwxyz.localhost:4405',
        `Origin: ${ORIGIN}`,
        'Cookie: theme=dark',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'),
    );
    // The authority never appears in the forwarded bytes, in any casing.
    expect(forwarded.toLowerCase()).not.toContain('astroix-client');
    expect(forwarded.toLowerCase()).not.toContain('__astroix_host');
    expect(forwarded).not.toContain('cap-7f3a');
    expect(forwarded).not.toContain('host-cap');
  });
});
