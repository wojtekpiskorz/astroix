/**
 * The raw upgrade tunnel (#233, F1; ADR-0005 "WebSocket upgrades
 * preserve the request URL, Host, Origin, HMR token, `vite-hmr`
 * subprotocol, and the upstream handshake bytes — the proxy never
 * synthesizes a `101`"): after the listener's Host/route/Origin/
 * subprotocol admission, the client socket and a fresh loopback socket
 * to the upstream are joined byte-blind in both directions. The
 * reconstructed client handshake (and any bytes already read past it)
 * goes up first; every byte after that — the upstream's own `101`, its
 * chosen extensions, and both directions of frames — is relayed without
 * parsing, without rewriting, and without this side ever answering the
 * client itself. An upstream that never connects or dies severs the
 * tunnel (both sockets destroyed): the honest failure is a broken
 * connection, never a fabricated handshake response.
 *
 * Real socket IO — watchlist tier like the plane's other IO glue; its
 * behavior truth is the raw HMR handshake fidelity lane over a stand-in
 * upstream that speaks the vite-hmr shapes.
 */

import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { astroixGeneratedHeaders } from '../origin/virtual-hosts.ts';
import type { StreamProxyUpstream } from './http-stream.ts';

export interface RawUpgradeTunnelInput {
  /** The client's reassembled handshake bytes (see `reconstructUpgradeHandshake`). */
  readonly handshake: string;
  /** Bytes node:http already read past the client's header block — forwarded after the handshake, before piping. */
  readonly head: Buffer;
  readonly clientSocket: Duplex;
  readonly upstream: StreamProxyUpstream;
  /** Both ends join the lease's tracked set here; revocation destroys them before child termination. */
  readonly track: (socket: Duplex) => void;
}

/** Joins the two sockets for the lifetime of the tunnel — byte-blind, bidirectional, sever-on-either-close. */
export function tunnelRawUpgrade(input: RawUpgradeTunnelInput): void {
  const upstreamSocket = connect({ host: input.upstream.host, port: input.upstream.port });
  input.track(input.clientSocket);
  input.track(upstreamSocket);
  const sever = (): void => {
    input.clientSocket.destroy();
    upstreamSocket.destroy();
  };
  upstreamSocket.on('connect', () => {
    upstreamSocket.write(input.handshake, 'latin1');
    if (input.head.length > 0) upstreamSocket.write(input.head);
    input.clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(input.clientSocket);
  });
  upstreamSocket.on('error', sever);
  input.clientSocket.on('error', sever);
  // A close on either end is terminal for the tunnel — no half-alive leg survives.
  upstreamSocket.on('close', () => input.clientSocket.destroy());
  input.clientSocket.on('close', () => upstreamSocket.destroy());
}

/**
 * Answers one refused upgrade with a bare HTTP response on the raw
 * socket and closes it — the upgrade's rejection shape (an HTTP status,
 * not a handshake): the client sees a failed connection, never a
 * synthesized `101`.
 */
export function respondRawAndClose(socket: Duplex, status: RawRefusalStatus): void {
  const headers = astroixGeneratedHeaders();
  let head = `HTTP/1.1 ${status} ${RAW_REFUSAL_PHRASES[status]}\r\n`;
  for (const [name, value] of Object.entries(headers)) head += `${name}: ${value}\r\n`;
  socket.end(`${head}\r\n`);
  socket.on('error', () => socket.destroy());
}

/** Exactly the refusal statuses this seam writes — fixed by its call sites, total by construction. */
export type RawRefusalStatus = 400 | 404 | 405 | 421;

const RAW_REFUSAL_PHRASES: Record<RawRefusalStatus, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
  421: 'Misdirected Request',
};
