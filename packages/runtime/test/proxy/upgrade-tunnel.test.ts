import { createHash } from 'node:crypto';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOriginListener, type OriginListener } from '../../origin/origin-listener.ts';
import { KEY_A, type StandInUpstream, startStandInUpstream, waitFor } from './stand-ins.ts';

/**
 * The raw HMR handshake fidelity leg (#233 focused tests; ADR-0005
 * "WebSocket upgrades preserve the request URL, Host, Origin, HMR
 * token, vite-hmr subprotocol, and the upstream handshake bytes — the
 * proxy never synthesizes a 101"): a stand-in Vite HMR upstream
 * answering with REAL WebSocket handshake math (the
 * `Sec-WebSocket-Accept` digest over the received key), a raw client
 * socket through the listener, and byte-exact assertions in both
 * directions — the upstream sees the client's exact handshake (token
 * and all), the client sees the upstream's exact `101` and frames, and
 * an upstream refusal arrives as the upstream's own bytes, never a
 * synthesized response.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLIENT_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const TOKEN = 'vite-hmr-token-4405';

interface HmrStandIn {
  readonly port: number;
  /** The exact bytes each connection handed over, split into handshake blocks and post-handshake frames. */
  readonly connections: Array<{ handshake: string; after: string }>;
  /** What the stand-in writes after its 101 — overridable per leg. */
  respond: (input: { readonly handshake: string }) => string;
  /** Writes raw bytes from the stand-in to its most recent connection. */
  sendToLast(frame: Buffer): void;
  close(): Promise<void>;
}

async function startHmrStandIn(): Promise<HmrStandIn> {
  const connections: Array<{ handshake: string; after: string }> = [];
  const sockets: Socket[] = [];
  // One shared mutable object for the closure and the caller — `respond`
  // is reassignable per leg and the server reads it live; the port and
  // the close path attach once the socket is bound.
  const standIn: {
    connections: Array<{ handshake: string; after: string }>;
    respond: (input: { readonly handshake: string }) => string;
    port: number;
    sendToLast: (frame: Buffer) => void;
    close: () => Promise<void>;
  } = {
    connections,
    respond: () =>
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptOf(CLIENT_KEY)}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
    port: 0,
    sendToLast: () => {},
    close: () => Promise.resolve(),
  };
  const server = createNetServer((socket) => {
    let buffer = '';
    let handshakeDone = false;
    const record = { handshake: '', after: '' };
    connections.push(record);
    sockets.push(socket);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        record.handshake = buffer.slice(0, end);
        const tail = buffer.slice(end + 4);
        handshakeDone = true;
        buffer = '';
        socket.write(standIn.respond({ handshake: record.handshake }), 'latin1');
        if (tail.length > 0) record.after += tail;
        return;
      }
      record.after += buffer;
      buffer = '';
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('hmr stand-in did not bind');
  standIn.port = address.port;
  standIn.sendToLast = (frame) => {
    sockets.at(-1)?.write(frame);
  };
  standIn.close = () => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return standIn;
}

function acceptOf(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/** The client's exact opening bytes — the fidelity oracle the upstream must receive verbatim. */
function opening(hostname: string, port: number): string {
  return [
    `GET /?token=${TOKEN} HTTP/1.1`,
    `Host: ${hostname}:${port}`,
    `Origin: http://${hostname}:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Sec-WebSocket-Key: ${CLIENT_KEY}`,
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Protocol: vite-hmr',
    '',
    '',
  ].join('\r\n');
}

/** One masked client text frame carrying `Hello` under a fixed mask — exact bytes the upstream must receive. */
const MASKED_CLIENT_FRAME = Buffer.from([
  0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58,
]);

/** One unmasked server text frame carrying `hello` — exact bytes the client must receive. */
const SERVER_FRAME = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);

interface RawClient {
  readonly socket: Socket;
  /** The bytes that arrived, in order. */
  readonly received: Buffer[];
  /** Resolves once `count` total bytes arrived. */
  waitFor(count: number, timeoutMs?: number): Promise<Buffer>;
}

function rawClient(port: number): Promise<RawClient> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const received: Buffer[] = [];
    const waiters: Array<{ count: number; resolve: (bytes: Buffer) => void }> = [];
    let total = 0;
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
      total += chunk.length;
      for (;;) {
        const next = waiters[0];
        if (next === undefined || next.count > total) break;
        waiters.shift();
        next.resolve(Buffer.concat(received));
      }
    });
    socket.once('connect', () => {
      resolve({
        socket,
        received,
        waitFor: (count, timeoutMs = 3000) =>
          new Promise((resolveWait, rejectWait) => {
            if (total >= count) {
              resolveWait(Buffer.concat(received));
              return;
            }
            const timer = setTimeout(
              () => rejectWait(new Error('rawClient: bytes never arrived')),
              timeoutMs,
            );
            waiters.push({
              count,
              resolve: (bytes) => {
                clearTimeout(timer);
                resolveWait(bytes);
              },
            });
          }),
      });
    });
  });
}

/** The stand-in's first connection record — present whenever a leg waits for it first. */
function firstConnection(standIn: HmrStandIn): { handshake: string; after: string } {
  const record = standIn.connections[0];
  if (record === undefined) throw new Error('no connection recorded by the stand-in');
  return record;
}

describe('raw HMR upgrade tunnel', () => {
  let listener: OriginListener;
  let standIn: HmrStandIn;
  let upstream: StandInUpstream;

  beforeEach(async () => {
    standIn = await startHmrStandIn();
    listener = await createOriginListener();
    listener.grantProjectLease({
      projectKey: KEY_A,
      upstream: { host: '127.0.0.1', port: standIn.port },
    });
    upstream = await startStandInUpstream();
  });

  afterEach(async () => {
    await listener.close();
    await standIn.close();
    await upstream.close();
  });

  it('relays the handshake byte-for-byte: URL+token, Host, Origin, subprotocol, and the upstream 101', async () => {
    const hostname = `${KEY_A}.localhost`;
    const client = await rawClient(listener.port);
    client.socket.write(opening(hostname, listener.port), 'latin1');
    // The client verifies the 101 like a real WebSocket client: the
    // accept digest must match ITS key — byte fidelity in both legs.
    const expectedHead = standIn.respond({ handshake: '' });
    const response = await client.waitFor(expectedHead.length);
    const text = response.toString('latin1');
    expect(text.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true);
    expect(text).toContain(`Sec-WebSocket-Accept: ${acceptOf(CLIENT_KEY)}`);
    expect(text).toContain('Sec-WebSocket-Protocol: vite-hmr');
    // The upstream received the client's exact handshake — token, Host,
    // Origin, key, subprotocol, original casing and order.
    await waitFor(() => (standIn.connections[0]?.handshake.length ?? 0) > 0);
    const received = firstConnection(standIn);
    expect(received.handshake).toBe(opening(hostname, listener.port).replace(/\r\n\r\n$/, ''));
  });

  it('strips the control authority before tunnelling — the handshake arrives with neither, everything else byte-identical (#338)', async () => {
    const hostname = `${KEY_A}.localhost`;
    const capability = 'cap-338-hmr';
    const hostCapability = 'host-cap-338';
    // The renderer-cased authority a non-browser client (or a future
    // injection into ws) could place on the upgrade: capitalized names,
    // the capability cookie riding a Cookie line with a legitimate peer.
    const sent = [
      `GET /?token=${TOKEN} HTTP/1.1`,
      `Host: ${hostname}:${listener.port}`,
      `Origin: http://${hostname}:${listener.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${CLIENT_KEY}`,
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: vite-hmr',
      `X-Astroix-Client: ${capability}`,
      `Cookie: __astroix_host=${hostCapability}; theme=dark`,
      '',
      '',
    ].join('\r\n');
    // The same opening minus the client-capability line and with the
    // Cookie line reduced to its surviving cookie — position, casing,
    // and every other byte unchanged.
    const expected = [
      `GET /?token=${TOKEN} HTTP/1.1`,
      `Host: ${hostname}:${listener.port}`,
      `Origin: http://${hostname}:${listener.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${CLIENT_KEY}`,
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: vite-hmr',
      'Cookie: theme=dark',
      '',
      '',
    ]
      .join('\r\n')
      .replace(/\r\n\r\n$/, '');
    const client = await rawClient(listener.port);
    client.socket.write(sent, 'latin1');
    // The response leg is untouched: the upstream's own 101 still answers
    // THIS client's key with the accept digest.
    const response = await client.waitFor(standIn.respond({ handshake: '' }).length);
    const text = response.toString('latin1');
    expect(text.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true);
    expect(text).toContain(`Sec-WebSocket-Accept: ${acceptOf(CLIENT_KEY)}`);
    await waitFor(() => (standIn.connections[0]?.handshake.length ?? 0) > 0);
    const received = firstConnection(standIn);
    expect(received.handshake).toBe(expected);
    expect(received.handshake.toLowerCase()).not.toContain('astroix-client');
    expect(received.handshake).not.toContain(capability);
    expect(received.handshake).not.toContain(hostCapability);
    client.socket.destroy();
  });

  it('tunnels frames in both directions untouched', async () => {
    const hostname = `${KEY_A}.localhost`;
    const client = await rawClient(listener.port);
    client.socket.write(opening(hostname, listener.port), 'latin1');
    const headLength = standIn.respond({ handshake: '' }).length;
    await client.waitFor(headLength);
    // server -> client frame
    standIn.sendToLast(SERVER_FRAME);
    const framed = await client.waitFor(headLength + SERVER_FRAME.length);
    expect(Buffer.from(framed.subarray(headLength))).toEqual(SERVER_FRAME);
    // client -> server frame (masked)
    client.socket.write(MASKED_CLIENT_FRAME);
    await waitFor(() => firstConnection(standIn).after.length >= MASKED_CLIENT_FRAME.length);
    expect(firstConnection(standIn).after.slice(0, MASKED_CLIENT_FRAME.length)).toBe(
      MASKED_CLIENT_FRAME.toString('latin1'),
    );
    client.socket.destroy();
  });

  it('never synthesizes a 101 — an upstream refusal arrives as the upstream bytes', async () => {
    standIn.respond = () =>
      'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
    const hostname = `${KEY_A}.localhost`;
    const client = await rawClient(listener.port);
    client.socket.write(opening(hostname, listener.port), 'latin1');
    const refusal = await client.waitFor(
      'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'.length,
    );
    expect(refusal.toString('latin1')).toBe(
      'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );
    client.socket.destroy();
  });

  it('refuses upgrades with a wrong Origin, a missing vite-hmr subprotocol, or on the retired host', async () => {
    const hostname = `${KEY_A}.localhost`;
    const origin = await rawClient(listener.port);
    origin.socket.write(
      opening(hostname, listener.port).replace(
        `Origin: http://${hostname}:${listener.port}`,
        'Origin: http://evil.example',
      ),
      'latin1',
    );
    expect((await origin.waitFor('HTTP/1.1 400'.length)).toString('latin1')).toContain('400');
    origin.socket.destroy();

    const protocol = await rawClient(listener.port);
    protocol.socket.write(
      opening(hostname, listener.port).replace(
        'Sec-WebSocket-Protocol: vite-hmr',
        'Sec-WebSocket-Protocol: chat',
      ),
      'latin1',
    );
    expect((await protocol.waitFor('HTTP/1.1 400'.length)).toString('latin1')).toContain('400');
    protocol.socket.destroy();

    // A stale host answers 421 on the raw upgrade path too.
    await listener.activeLease?.revoke();
    const stale = await rawClient(listener.port);
    stale.socket.write(opening(hostname, listener.port), 'latin1');
    expect((await stale.waitFor('HTTP/1.1 421'.length)).toString('latin1')).toContain('421');
    stale.socket.destroy();
    expect(upstream.requests).toHaveLength(0);
  });

  it('refuses upgrades on the launcher host and inside the reserved namespace', async () => {
    const launcher = await rawClient(listener.port);
    launcher.socket.write(opening('launcher.localhost', listener.port), 'latin1');
    expect((await launcher.waitFor('HTTP/1.1 404'.length)).toString('latin1')).toContain('404');
    launcher.socket.destroy();

    const reserved = await rawClient(listener.port);
    reserved.socket.write(
      opening(`${KEY_A}.localhost`, listener.port).replace(
        `GET /?token=${TOKEN}`,
        `GET /__astroix/?token=${TOKEN}`,
      ),
      'latin1',
    );
    expect((await reserved.waitFor('HTTP/1.1 404'.length)).toString('latin1')).toContain('404');
    reserved.socket.destroy();
    expect(upstream.requests).toHaveLength(0);
  });
});
