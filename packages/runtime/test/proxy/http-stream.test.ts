import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { proxyHttpStream } from '../../proxy/http-stream.ts';
import { waitFor } from './stand-ins.ts';

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
