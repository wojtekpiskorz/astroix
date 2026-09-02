/**
 * The stream HTTP proxy leg (#233, F1; ADR-0005 "Every non-reserved HTTP
 * request streams to the managed Astro dev server"): one proxied
 * exchange — the client's method, VERBATIM request target (natural URL,
 * resolved base included, query untouched), and headers, Host among
 * them preserved exactly, forwarded to the loopback upstream; the
 * upstream's status and headers written back and the body piped through
 * unmodified (SSE-compatible streaming: no buffering is added). The
 * upstream is never request-selected — the listener hands this leg the
 * active lease's upstream and nothing else.
 *
 * This module is real network IO — watchlist tier like the plane's other
 * IO glue; its behavior truth is the real-socket focused lane over
 * stand-in upstreams (`test/proxy/**`). Every socket it touches is
 * reported to the listener's tracking seam so a lease revocation severs
 * the exchange before the children are terminated.
 */

import { type IncomingMessage, type ServerResponse, request as upstreamRequest } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { astroixGeneratedHeaders } from '../origin/virtual-hosts.ts';

/** The loopback upstream an active origin lease bound — the managed dev server's own address. */
export interface StreamProxyUpstream {
  readonly host: string;
  readonly port: number;
}

export interface HttpStreamProxyInput {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly upstream: StreamProxyUpstream;
  /** Every socket of the exchange joins the lease's tracked set here; revocation destroys them. */
  readonly track: (socket: Duplex) => void;
}

/** The one failure status this leg synthesizes — upstream unreachable or dead mid-exchange. */
export const STREAM_PROXY_FAILURE_STATUS = 502;

/**
 * Streams one exchange. Fail-closed hygiene: before any upstream byte
 * arrives the only synthesized response is a bare 502; once the upstream
 * responded, a mid-stream failure destroys the connection rather than
 * inventing bytes the upstream never sent.
 */
export function proxyHttpStream(input: HttpStreamProxyInput): void {
  // Both legs of the exchange join the tracked set — SYNCHRONOUSLY, in
  // the same turn this function runs: the client socket directly, the
  // upstream socket through a `createConnection` hook (with no agent
  // option and the hook provided, node:http invokes it inside the
  // request constructor). A `revoke()` landing in the former
  // request-creation-to-'socket'-event window therefore still counts
  // and destroys the upstream leg — the close report never undercounts.
  input.track(input.request.socket);
  const forwarded = upstreamRequest({
    host: input.upstream.host,
    port: input.upstream.port,
    method: input.request.method,
    path: input.request.url,
    // The parsed headers as received — the Host header rides verbatim:
    // node:http uses a provided host instead of deriving one from the
    // connection target (the AC's "HTTP preserves Host").
    headers: { ...input.request.headers },
    createConnection: () => {
      const socket = connect(input.upstream.port, input.upstream.host);
      input.track(socket);
      return socket;
    },
  });
  forwarded.on('response', (upstream) => {
    input.response.writeHead(upstream.statusCode ?? STREAM_PROXY_FAILURE_STATUS, upstream.headers);
    upstream.pipe(input.response);
  });
  forwarded.on('error', () => {
    if (input.response.headersSent) {
      input.response.destroy();
      return;
    }
    input.response.writeHead(STREAM_PROXY_FAILURE_STATUS, astroixGeneratedHeaders());
    input.response.end();
  });
  input.request.on('aborted', () => forwarded.destroy());
  input.request.pipe(forwarded);
}

/** Writes one listener-synthesized refusal: bare status, marker header, no details, connection closed. */
export function sendGeneratedResponse(response: ServerResponse, status: number): void {
  response.writeHead(status, astroixGeneratedHeaders());
  response.end();
}
