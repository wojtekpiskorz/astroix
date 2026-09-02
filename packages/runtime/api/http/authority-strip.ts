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
 * wiring into the proxy path belongs to the Electron host lane (#246,
 * its upstream HTTP and HMR header-stripping legs), which calls this
 * one function so the strip has exactly one definition.
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
 * #246) — a capitalized `X-Astroix-Client` or `Cookie` must be stripped
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
