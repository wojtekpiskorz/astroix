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
import type { Duplex } from 'node:stream';
import { ASTROIX_GENERATED_HEADER, astroixGeneratedHeaders } from '../origin/virtual-hosts.ts';

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
  // Both legs of the exchange join the tracked set: revocation severs
  // the client side AND the upstream connection.
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
    agent: false,
  });
  forwarded.on('socket', (socket) => input.track(socket));
  forwarded.on('response', (upstream) => {
    input.response.writeHead(upstream.statusCode ?? STREAM_PROXY_FAILURE_STATUS, upstream.headers);
    upstream.pipe(input.response);
  });
  forwarded.on('error', () => {
    if (input.response.headersSent) {
      input.response.destroy();
      return;
    }
    input.response.writeHead(
      STREAM_PROXY_FAILURE_STATUS,
      astroixGeneratedHeaders(STREAM_PROXY_FAILURE_STATUS),
    );
    input.response.end();
  });
  input.request.on('aborted', () => forwarded.destroy());
  input.request.pipe(forwarded);
}

/** Writes one listener-synthesized refusal: bare status, marker header, no details, connection closed. */
export function sendGeneratedResponse(response: ServerResponse, status: number): void {
  response.writeHead(status, astroixGeneratedHeaders(status));
  response.end();
}

/** True when a response came from the listener itself, never the upstream — the health probe's disambiguator. */
export function isListenerGenerated(headers: IncomingMessage['headers']): boolean {
  return headers[ASTROIX_GENERATED_HEADER] !== undefined;
}
