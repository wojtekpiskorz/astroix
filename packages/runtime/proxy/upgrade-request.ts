/**
 * The raw-upgrade admission and handshake reconstruction (#233, F1;
 * ADR-0005 "the proxy never synthesizes a 101", ADR-0006 §7 "the Vite
 * HMR upgrade validates exact Host/Origin, the active route, the
 * activation capability, and Vite's token/subprotocol contract", ADR-0007
 * "WebSocket upgrades independently validate Host, Origin, route,
 * authorization, activation, and subprotocol"). Pure classification and
 * byte assembly over the parsed request — the Host/route legs of that
 * validation live in the listener composition (the router resolves the
 * host, the target classification the route); the activation-capability
 * leg is the session lanes' (F2/F3), and the token is Vite's own — this
 * seam PRESERVES both, byte for byte, and validates everything that
 * exists today: the WebSocket upgrade shape, the `vite-hmr`
 * subprotocol, and the exact same-origin Origin. The pair list it
 * reassembles arrives from the listener already stripped of the
 * control-plane authority (ADR-0006 §3 — F2's definition module owns
 * that leg, `stripAuthorityFromRawPairs`, #338); this seam reconstructs
 * exactly what it is handed, byte for byte.
 */

/** Why an upgrade was refused admission — sanitized vocabulary only. */
export type UpgradeRejectionReason =
  | 'not-get-upgrade'
  | 'not-websocket-upgrade'
  | 'missing-websocket-key'
  | 'unsupported-websocket-version'
  | 'missing-origin'
  | 'origin-mismatch'
  | 'missing-hmr-subprotocol';

/** The admission outcome for one upgrade request. */
export type UpgradeAdmission =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'rejected'; readonly reason: UpgradeRejectionReason };

/** The parsed-header shape both node:http and test fakes satisfy — structural, no node imports at runtime. */
export type ParsedHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Admits one upgrade for tunneling. Everything checked is checkable
 * without session authority: the RFC 6455 opening-shape (GET,
 * `Connection: Upgrade`, `Upgrade: websocket`, a `Sec-WebSocket-Key`,
 * version 13), the `vite-hmr` subprotocol (the certified pair's only
 * transparent WebSocket — any other subprotocol has no business being
 * tunneled), and the Origin — present and exactly the active project
 * origin, the same-origin constraint browsers impose anyway (RFC 6455
 * makes Origin validation a server decision; this is ours). The Vite
 * HMR token is NOT validated here — Vite minted it, Vite checks it, and
 * the tunnel preserves it.
 */
export function validateUpgradeRequest(input: {
  readonly method: string;
  readonly headers: ParsedHeaders;
  readonly expectedOrigin: string;
}): UpgradeAdmission {
  if (input.method !== 'GET') return refuse('not-get-upgrade');
  const headers = lowercaseKeys(input.headers);
  if (!tokenList(headers.connection).includes('upgrade')) return refuse('not-websocket-upgrade');
  if (String(headers.upgrade ?? '').toLowerCase() !== 'websocket')
    return refuse('not-websocket-upgrade');
  if (
    typeof headers['sec-websocket-key'] !== 'string' ||
    headers['sec-websocket-key'].length === 0
  ) {
    return refuse('missing-websocket-key');
  }
  if (headers['sec-websocket-version'] !== '13') return refuse('unsupported-websocket-version');
  const origin = headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return refuse('missing-origin');
  if (origin.toLowerCase() !== input.expectedOrigin.toLowerCase()) return refuse('origin-mismatch');
  if (!tokenList(headers['sec-websocket-protocol']).includes('vite-hmr')) {
    return refuse('missing-hmr-subprotocol');
  }
  return { kind: 'admitted' };
}

function refuse(reason: UpgradeRejectionReason): UpgradeAdmission {
  return { kind: 'rejected', reason };
}

/** Splits a (possibly comma-joined) header value into lowercased tokens. */
function tokenList(value: string | string[] | undefined): string[] {
  const joined = Array.isArray(value) ? value.join(',') : value;
  if (joined === undefined) return [];
  return joined
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function lowercaseKeys(headers: ParsedHeaders): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/** The structural slice of an upgrade request the handshake reconstruction reads — node:http's IncomingMessage satisfies it. */
export interface HandshakeSource {
  readonly method: string;
  readonly url: string;
  readonly httpVersion: string;
  readonly rawHeaders: readonly string[];
}

/**
 * Reassembles the client's exact handshake bytes: the original request
 * line and every raw header pair in original order and casing — the
 * tunnel's upstream leg is these bytes plus the already-read `head`
 * bytes, nothing else. Written latin1 (the encoding node:http already
 * used to decode the raw pairs), so what leaves for the upstream is
 * byte-identical to what arrived: URL (token included), Host, Origin,
 * `Sec-WebSocket-Protocol`, and the key the upstream's
 * `Sec-WebSocket-Accept` will answer.
 */
export function reconstructUpgradeHandshake(request: HandshakeSource): string {
  let out = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    out += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
  }
  return `${out}\r\n`;
}
