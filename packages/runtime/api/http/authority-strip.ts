import type { ParsedHeaders } from '../../proxy/upgrade-request.ts';
import { CLIENT_CAPABILITY_HEADER } from './client-bindings.ts';
import { CAPABILITY_COOKIE_NAME } from './host-capability.ts';

/**
 * The canonical strip of control-plane authority before anything
 * forwards upstream (#234, F2; ADR-0006 §3 "strips it before forwarding
 * either request to the managed Astro/Vite server"): the host
 * capability cookie and the injected client-capability header never
 * reach the managed dev server — not over the HTTP stream proxy, not
 * over a raw HMR upgrade tunnel. Pure header-set surgery; the live
 * wiring is the two proxy legs (#338): the stream proxy forwards
 * `stripControlAuthority`'s answer directly, and the upgrade path feeds
 * `reconstructUpgradeHandshake` from `stripAuthorityFromRawPairs` —
 * both defined here, so every drop and cookie decision has exactly one
 * home.
 *
 * Everything else passes through untouched — other cookies, the Host,
 * the HMR token, Vite's subprotocol: the strip is surgical, never a
 * rewrite. Authority names are matched case-insensitively (both the
 * parsed view and the raw-cased handshake view spell them), and every
 * kept header keeps its own name bytes verbatim.
 */

/** Drops the capability cookie from one `Cookie` header value; `undefined` when nothing remains. */
export function stripCapabilityCookie(cookieHeader: string): string | undefined {
  const kept = cookieHeader
    .split(';')
    .filter((part) => {
      const eq = part.indexOf('=');
      const name = (eq === -1 ? part : part.slice(0, eq)).trim();
      return name !== CAPABILITY_COOKIE_NAME;
    })
    .map((part) => part.trim());
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/** The header shape both the stream proxy and the upgrade tunnel forward — node:http's parsed view, or the raw-cased handshake view. */
export type ForwardedHeaders = ParsedHeaders;

/**
 * Returns the forwarded view of one request's headers with every
 * control-plane authority removed: the client-capability header dropped
 * outright, the capability cookie filtered out of the `Cookie` value
 * (the header itself dropped when it held nothing else). A new object —
 * the input is never mutated.
 *
 * Name matching is case-insensitive and name preservation is verbatim.
 * The two views this serves spell headers differently: node:http's
 * parsed view lowercases every name, while the raw HMR handshake view
 * F1 reconstructs from `rawHeaders` preserves the client's original
 * casing (`Origin-listener` → `reconstructUpgradeHandshake`, wired by
 * #338) — a capitalized `X-Astroix-Client` or `Cookie` must be stripped
 * just the same, and every header that stays must keep its own bytes
 * exactly: the strip is surgical, never a rewrite, not even a recasing.
 */
export function stripControlAuthority(
  headers: ForwardedHeaders,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  const cookieKeys: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === CLIENT_CAPABILITY_HEADER) continue;
    if (lower === 'cookie') cookieKeys.push(name);
    out[name] = value;
  }
  // EVERY cookie-cased key is stripped, not just the first: a
  // hand-crafted handshake carrying `Cookie` AND `COOKIE` as distinct
  // keys must not smuggle a capability through whichever one the scan
  // happened to record (the cookie law is absolute — browsers send one
  // canonical header, but this function's contract does not assume a
  // browser on the other end).
  for (const key of cookieKeys) {
    const cookie = out[key];
    if (typeof cookie === 'string') {
      const stripped = stripCapabilityCookie(cookie);
      if (stripped === undefined) delete out[key];
      else out[key] = stripped;
    } else if (Array.isArray(cookie)) {
      const stripped = cookie
        .map((value) => stripCapabilityCookie(value))
        .filter((value): value is string => value !== undefined);
      if (stripped.length === 0) delete out[key];
      else if (stripped.length === 1) out[key] = stripped[0];
      else out[key] = stripped;
    }
  }
  return out;
}

/**
 * The pair-level primitive of the strip (#338 review round 1): ONE raw
 * handshake pair's forwarded answer. The raw-pair leg routes through
 * this, never through the record shape — a header named `__proto__` (a
 * legal RFC 7230 token a hand-crafted client can send on an upgrade)
 * must keep its bytes like any other non-authority pair, not vanish
 * into object semantics. Name matching is case-insensitive; every kept
 * value is the pair's own bytes, except the cookie rewrite.
 */
export function stripAuthorityFromPair(name: string, value: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === CLIENT_CAPABILITY_HEADER) return undefined;
  if (lower === 'cookie') return stripCapabilityCookie(value);
  return value;
}

/**
 * The handshake view's header pairs with the control-plane authority
 * removed (#338; ADR-0006 §3 "strips it before forwarding either
 * request to the managed Astro/Vite server"): the pair list
 * `reconstructUpgradeHandshake` reassembles never carries the
 * client-capability header or the host capability cookie up to the
 * managed dev server. Each pair through {@link stripAuthorityFromPair}
 * — no part of the strip is decided anywhere else — and every kept pair
 * keeps its exact name bytes, value bytes, and position: URL token,
 * Host, Origin, subprotocol, key, duplicate spellings, original casing,
 * and order all ride as they arrived.
 */
export function stripAuthorityFromRawPairs(rawHeaders: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? '';
    const value = rawHeaders[i + 1] ?? '';
    const forwarded = stripAuthorityFromPair(name, value);
    if (forwarded === undefined) continue;
    kept.push(name, forwarded);
  }
  return kept;
}
