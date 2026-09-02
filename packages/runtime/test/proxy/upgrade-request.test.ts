import { describe, expect, it } from 'vitest';
import {
  reconstructUpgradeHandshake,
  validateUpgradeRequest,
} from '../../proxy/upgrade-request.ts';

/**
 * The upgrade admission and handshake-reconstruction focused tests
 * (#233): the RFC 6455 opening shape, the `vite-hmr` subprotocol gate,
 * the exact same-origin Origin, and the byte-true reassembly of the
 * client's handshake (original casing, order, duplicates visible).
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
