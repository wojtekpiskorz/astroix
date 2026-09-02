import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';

/**
 * Real-socket stand-ins for the F1 focused lane (#233): a loopback
 * upstream speaking the managed dev server's HTTP shapes, raw-socket
 * request helpers that fix the Host evidence byte-for-byte, and one
 * auto-torn-down listener fixture. Zero mocks on the socket seams —
 * every leg runs against real loopback sockets on OS-assigned ports
 * (the kernel-lease/private-boot process-lane idiom, minus children).
 */

/** Two valid routing keys (26 lowercase-Base32 chars, the protocol's shape). */
export const KEY_A = 'abcdefghijklmnopqrstuvwxyz';
export const KEY_B = 'abcdefghijklmnopqrstuvwxy2';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly host: string | undefined;
  readonly headers: IncomingMessage['headers'];
}

export interface StandInUpstream {
  readonly port: number;
  readonly requests: RecordedRequest[];
  /** The exact bytes the upstream received, per connection — the fidelity oracle. */
  readonly receivedChunks: Buffer[];
  readonly server: Server;
  close(): Promise<void>;
}

export interface StandInRoute {
  readonly path: string;
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  /** When true the response head is written and the body NEVER ends — the in-flight-exchange leg's hold-open route. */
  readonly hanging?: boolean;
}

/**
 * One stand-in managed dev server: records every request (parsed +
 * raw chunks) and serves the given natural routes. The default `/`
 * route carries the marker element the direct-DOM leg queries.
 */
export async function startStandInUpstream(
  routes: readonly StandInRoute[] = [],
): Promise<StandInUpstream> {
  const requests: RecordedRequest[] = [];
  const receivedChunks: Buffer[] = [];
  const served: readonly StandInRoute[] =
    routes.length > 0
      ? routes
      : [
          {
            path: '/',
            status: 200,
            body: '<!doctype html><html><body><main id="natural-root">fixture page</main></body></html>',
            contentType: 'text/html; charset=utf-8',
          },
        ];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      host: request.headers.host,
      headers: { ...request.headers },
    });
    request.on('data', (chunk: Buffer) => receivedChunks.push(chunk));
    const path = (request.url ?? '').split('?')[0] ?? '';
    const route = served.find((candidate) => candidate.path === path);
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('no such natural route');
      return;
    }
    response.writeHead(route.status, { 'content-type': route.contentType });
    if (route.hanging === true) {
      response.write(route.body);
      return; // no end — the exchange stays open until revocation severs it
    }
    response.end(route.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('stand-in upstream did not bind');
  return {
    port: address.port,
    requests,
    receivedChunks,
    server,
    close: () => {
      if (server.listening === false) return Promise.resolve(); // idempotent: legs may kill the upstream early
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

export interface RawExchange {
  readonly status: number;
  readonly headers: string;
  readonly body: string;
  readonly bytes: Buffer;
}

/** Sends exact request bytes to a loopback port and collects everything that comes back. */
export function rawExchange(port: number, request: string, timeoutMs = 3000): Promise<RawExchange> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(request);
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      finish();
    }, timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      // Settle as soon as a complete response head arrived and the
      // connection closes (generated responses always close), or the
      // timer bounds the wait for streaming/tunnel legs.
      const joined = Buffer.concat(chunks).toString('latin1');
      if (joined.includes('\r\n\r\n') && !socket.writableEnded) {
        if (joined.startsWith('HTTP/1.1 101')) return; // tunnel: keep collecting frames
        clearTimeout(timer);
        socket.end();
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      finish();
    });
    function finish(): void {
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(text);
      resolve({
        status: statusMatch === null ? 0 : Number.parseInt(statusMatch[1] ?? '0', 10),
        headers: split === -1 ? text : text.slice(0, split),
        body: split === -1 ? '' : text.slice(split + 4),
        bytes,
      });
    }
  });
}

/** The default raw GET the Host-rejection legs send — Host evidence is the variable under test. */
export function rawGet(target: string, hostHeader: string): string {
  return `GET ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`;
}

/** Resolves when `probe` turns true — the one bounded polling helper for the real-socket legs (never a sleep-race). */
export async function waitFor(probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (probe()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
