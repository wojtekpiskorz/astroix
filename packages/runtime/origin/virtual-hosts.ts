/**
 * The origin vocabulary and the request-admission classification (#233,
 * F1; ADR-0005 "Origin and proxy contract" + ADR-0007 "Listener and
 * routing"): the loopback virtual-host names, the strict Host-header
 * parse, and the request-target classification that owns the reserved
 * `/__astroix/` namespace boundary. Pure string classification only —
 * no socket, no server, no state; the routing state machine lives in
 * {@link ./host-router.ts} and the listener composition in
 * {@link ./origin-listener.ts}.
 *
 * The admission rules here are the ADR-0007 mandatory controls that are
 * expressible per-request without session authority: reject malformed,
 * duplicate, trailing-dot, and port-mismatch Host values; reject
 * absolute-form and asterisk-form request targets; reject targets whose
 * percent-decoding disagrees with their raw form about the reserved
 * namespace (ambiguous encodings). `.localhost` is routing, never
 * authority (RFC 6761 §6.3) — a foreign domain rebound to loopback is
 * simply not in the vocabulary and never routes.
 */

/** Astroix's reserved namespace (ADR-0005): app assets, control requests, events — never proxied upstream. */
export const RESERVED_NAMESPACE = '/__astroix';

/** The neutral launcher's virtual host (ADR-0005): shown before any project is active. */
export const LAUNCHER_HOSTNAME = 'launcher.localhost';

/** The header that marks every listener-synthesized response (never present on a proxied upstream response). */
export const ASTROIX_GENERATED_HEADER = 'x-astroix-generated';

/** The headers every listener-synthesized response carries — empty bodies, no details (ADR-0006 §7 output hygiene). */
export function astroixGeneratedHeaders(status: number): Record<string, string> {
  return {
    'content-length': '0',
    'cache-control': 'no-store',
    connection: 'close',
    [ASTROIX_GENERATED_HEADER]: '1',
    ...(status === 421 ? { 'misdirected-host': '1' } : {}),
  };
}

/** The active project's virtual host: the exact project-key hostname (ADR-0006 §1 — the key is the DNS-safe routing name). */
export function projectHostname(projectKey: string): string {
  return `${projectKey}.localhost`;
}

/** The published launcher origin — exists only after the listener acquired its socket (ADR-0007). */
export function launcherOrigin(port: number): string {
  return `http://${LAUNCHER_HOSTNAME}:${port}`;
}

/** The published active-project origin — a fresh browser origin per project-key record (ADR-0004/0005). */
export function projectOrigin(projectKey: string, port: number): string {
  return `http://${projectHostname(projectKey)}:${port}`;
}

/** Why a Host header (or its absence) was refused — sanitized vocabulary, never the header value itself. */
export type HostRejectionReason =
  | 'missing-host'
  | 'duplicate-host'
  | 'malformed-host'
  | 'trailing-dot-host'
  | 'host-port-mismatch';

/** The outcome of the strict Host parse: a lowercase hostname, or a refusal reason. */
export type HostParse = { readonly kind: 'host'; readonly hostname: string } | HostRejection;

/** The discriminated refusal shape both Host and target classification share. */
export interface HostRejection {
  readonly kind: 'rejected';
  readonly reason: HostRejectionReason;
}

/**
 * Parses one request's Host evidence: exactly one Host header (counted
 * from the raw header pairs, so a duplicate can never hide behind the
 * parser's comma-join), structurally valid, optional port equal to the
 * listener's own. Hostnames compare case-insensitively (HTTP semantics);
 * a trailing dot is a distinct DNS name and refused outright rather than
 * silently routed (the ADR-0007 rejection set).
 */
export function parseHostHeader(input: {
  readonly value: string | undefined;
  readonly count: number;
  readonly expectedPort: number;
}): HostParse {
  if (input.count === 0) return reject('missing-host');
  if (input.count > 1) return reject('duplicate-host');
  const value = input.value ?? '';
  if (value.length === 0 || value !== value.trim()) return reject('malformed-host');
  if (/[\t\n\r #%/\\?@[\]]/.test(value)) return reject('malformed-host');
  const { hostname, port } = splitHostPort(value);
  if (hostname.length === 0 || hostname.includes('..') || hostname.startsWith('.')) {
    return reject('malformed-host');
  }
  if (hostname.endsWith('.')) return reject('trailing-dot-host');
  if (port !== undefined && port !== input.expectedPort) return reject('host-port-mismatch');
  return { kind: 'host', hostname: hostname.toLowerCase() };
}

function reject(reason: HostRejectionReason): HostRejection {
  return { kind: 'rejected', reason };
}

/** The empty-hostname signal every malformed shape collapses to — the caller maps it to `malformed-host`. */
const MALFORMED_HOST: { hostname: ''; port: undefined } = { hostname: '', port: undefined };

/**
 * Splits `host[:port]`. A second bare colon or a non-numeric port is
 * malformed; the value's character pre-check has already refused IP
 * literals and every separator the authority grammar never carries in a
 * `.localhost` virtual-host name, so only one optional colon remains.
 */
function splitHostPort(value: string): { hostname: string; port: number | undefined } {
  const colon = value.indexOf(':');
  if (colon === -1) return { hostname: value, port: undefined };
  if (value.indexOf(':', colon + 1) !== -1) return MALFORMED_HOST;
  return withPort(value.slice(0, colon), value.slice(colon + 1));
}

function withPort(
  hostname: string,
  digits: string,
): { hostname: string; port: number | undefined } {
  if (digits.length === 0 || !/^\d+$/.test(digits)) return MALFORMED_HOST;
  return { hostname, port: Number.parseInt(digits, 10) };
}

/** Why a request target was refused before routing — sanitized vocabulary only. */
export type TargetRejectionReason =
  | 'absolute-form-target'
  | 'asterisk-form-target'
  | 'malformed-target'
  | 'ambiguous-reserved-encoding';

/** The outcome of request-target classification: a natural (proxyable) target, the reserved namespace, or a refusal. */
export type RequestTargetClassification =
  | { readonly kind: 'natural'; readonly target: string }
  | { readonly kind: 'reserved' }
  | { readonly kind: 'rejected'; readonly reason: TargetRejectionReason };

/**
 * Classifies one request target (the request line's path-plus-query, as
 * received): `natural` targets are forwarded VERBATIM — the natural URL,
 * resolved base included, never a synthetic canvas route or a
 * query-parameter wrapper; `reserved` is Astroix's own namespace and is
 * never proxied; everything else is refused: absolute-form and
 * asterisk-form targets, fragments, undecodable percent sequences, and
 * encodings whose decoded form disagrees with the raw form about the
 * reserved boundary (`/__astroix%2F…`, `/%5f%5fastroix/…`).
 */
export function classifyRequestTarget(rawTarget: string | undefined): RequestTargetClassification {
  if (rawTarget === undefined || rawTarget.length === 0) {
    return { kind: 'rejected', reason: 'malformed-target' };
  }
  if (rawTarget === '*') return { kind: 'rejected', reason: 'asterisk-form-target' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawTarget)) {
    return { kind: 'rejected', reason: 'absolute-form-target' };
  }
  if (rawTarget.includes('#')) return { kind: 'rejected', reason: 'malformed-target' };
  if (!rawTarget.startsWith('/')) return { kind: 'rejected', reason: 'malformed-target' };
  const queryAt = rawTarget.indexOf('?');
  const rawPath = queryAt === -1 ? rawTarget : rawTarget.slice(0, queryAt);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { kind: 'rejected', reason: 'malformed-target' };
  }
  const rawReserved = isReservedPath(rawPath);
  if (rawReserved !== isReservedPath(decoded)) {
    return { kind: 'rejected', reason: 'ambiguous-reserved-encoding' };
  }
  return rawReserved ? { kind: 'reserved' } : { kind: 'natural', target: rawTarget };
}

/** True for the reserved namespace root and everything below it — `/__astroixfoo` is a different segment and stays natural. */
export function isReservedPath(path: string): boolean {
  return path === RESERVED_NAMESPACE || path.startsWith(`${RESERVED_NAMESPACE}/`);
}

/** Every listener-synthesized status: malformed-class refusals 400, unknown virtual host 404, retired host 421 (the ticket's pin). */
export type ListenerRejectionReason =
  | HostRejectionReason
  | TargetRejectionReason
  | 'unknown-host'
  | 'retired-host';

export const LISTENER_REJECTION_STATUS: Record<ListenerRejectionReason, number> = {
  'missing-host': 400,
  'duplicate-host': 400,
  'malformed-host': 400,
  'trailing-dot-host': 400,
  'host-port-mismatch': 400,
  'absolute-form-target': 400,
  'asterisk-form-target': 400,
  'malformed-target': 400,
  'ambiguous-reserved-encoding': 400,
  'unknown-host': 404,
  'retired-host': 421,
};
