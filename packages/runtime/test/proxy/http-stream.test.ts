import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { proxyHttpStream } from '../../proxy/http-stream.ts';
import {
  type RecordedRequest,
  rawExchange,
  type StandInUpstream,
  startStandInUpstream,
  waitFor,
} from './stand-ins.ts';

/**
 * The synchronous-registration regression leg (#314 review round,
 * finding 2): the upstream socket must join the tracked set in the SAME
 * turn `proxyHttpStream` runs — through a `createConnection` hook that
 * node:http invokes inside the request constructor — not one
 * 'socket'-event tick later. A `revoke()` landing in that former window
 * could not undercount the close report. The proof drives the real
 * function over a real captured (request, response) pair from a real
 * node:http server, against a real (never-answering) upstream socket —
 * and asserts the tracked set synchronously, before any event can fire.
 *
 * The control-authority strip leg (#338, ADR-0006 §3): a real captured
 * exchange carrying the client-capability header and the host
 * capability cookie proxies to a stand-in managed dev server — neither
 * authority may arrive, everything else must.
 */

describe('proxyHttpStream (synchronous socket registration)', () => {
  it('registers BOTH exchange legs in the turn it runs — a revoke in the creation window cannot undercount', async () => {
    let captured: { request: IncomingMessage; response: ServerResponse } | undefined;
    const harness = createServer((request, response) => {
      captured = { request, response };
    });
    let upstreamConnections = 0;
    const upstreamSockets: import('node:net').Socket[] = [];
    const upstream = createNetServer((socket) => {
      upstreamConnections += 1;
      upstreamSockets.push(socket);
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        harness.once('error', reject);
        harness.listen(0, '127.0.0.1', () => resolve());
      }),
      new Promise<void>((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(0, '127.0.0.1', () => resolve());
      }),
    ]);
    const harnessPort = portOf(harness);
    const client = connect({ host: '127.0.0.1', port: harnessPort });
    client.on('error', () => {});
    client.on('data', () => {}); // flowing mode — the close observation needs it
    await new Promise<void>((resolve) => client.once('connect', resolve));
    client.write('GET /x HTTP/1.1\r\nHost: harness\r\n\r\n');
    await waitFor(() => captured !== undefined);
    const exchange = captured as { request: IncomingMessage; response: ServerResponse };

    const tracked: Duplex[] = [];
    proxyHttpStream({
      request: exchange.request,
      response: exchange.response,
      upstream: { host: '127.0.0.1', port: portOf(upstream) },
      track: (socket) => tracked.push(socket),
    });
    // The regression assertion itself — synchronous, same turn: the
    // client leg AND the upstream leg (created inside the request
    // constructor through createConnection) are already registered.
    expect(tracked).toHaveLength(2);
    for (const socket of tracked) expect(socket.destroyed).toBe(false);
    await waitFor(() => upstreamConnections === 1); // the upstream leg is a real live connection

    // A revoke-shaped destroy of the tracked set severs the exchange:
    // the client observes the connection's close.
    for (const socket of tracked) socket.destroy();
    await new Promise<void>((resolve) => client.once('close', resolve));
    expect(client.destroyed).toBe(true);

    harness.closeAllConnections();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise<void>((resolve) => harness.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});

function portOf(server: { address(): { port: number } | string | null }): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return address.port;
}

describe('proxyHttpStream (the control-authority strip, #338)', () => {
  it('forwards the exchange with the host cookie and the client capability stripped — everything else arrives', async () => {
    let captured: { request: IncomingMessage; response: ServerResponse } | undefined;
    const harness = createServer((request, response) => {
      captured = { request, response };
    });
    const upstream: StandInUpstream = await startStandInUpstream();
    await new Promise<void>((resolve, reject) => {
      harness.once('error', reject);
      harness.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      // A raw client sending the authority in mixed casing — node's
      // parsed view lowercases the names, and the strip must catch the
      // header regardless of how the client spelled it.
      const exchangePromise = rawExchange(
        portOf(harness),
        [
          'GET /?token=vite-tok HTTP/1.1',
          'Host: harness',
          'X-Astroix-Client: cap-338-http',
          'Cookie: __astroix_host=host-cap-338; theme=dark',
          'X-Custom-Kept: verbatim-value',
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );
      await waitFor(() => captured !== undefined);
      const exchange = captured as { request: IncomingMessage; response: ServerResponse };
      proxyHttpStream({
        request: exchange.request,
        response: exchange.response,
        upstream: { host: '127.0.0.1', port: upstream.port },
        track: () => {},
      });
      const proxied = await exchangePromise;
      expect(proxied.status).toBe(200); // the exchange itself completed untouched
      expect(upstream.requests).toHaveLength(1);
      const seen = upstream.requests[0] as RecordedRequest;
      // Neither authority arrives, in any casing.
      expect(seen.headers['x-astroix-client']).toBeUndefined();
      expect(JSON.stringify(seen.headers).toLowerCase()).not.toContain('astroix-client');
      // The cookie line survives with its OTHER cookies — surgical, never a rewrite.
      expect(seen.headers.cookie).toBe('theme=dark');
      // Everything else rides: method, target, Host, the custom header.
      expect(seen.method).toBe('GET');
      expect(seen.url).toBe('/?token=vite-tok');
      expect(seen.host).toBe('harness');
      expect(seen.headers['x-custom-kept']).toBe('verbatim-value');
      // The raw bytes the upstream received carry no capability byte at all.
      const raw = Buffer.concat(upstream.receivedChunks).toString('latin1').toLowerCase();
      expect(raw).not.toContain('astroix-client');
      expect(raw).not.toContain('__astroix_host');
      expect(raw).not.toContain('cap-338-http');
      expect(raw).not.toContain('host-cap-338');
    } finally {
      harness.closeAllConnections();
      await new Promise<void>((resolve) => harness.close(() => resolve()));
      await upstream.close();
    }
  });
});
