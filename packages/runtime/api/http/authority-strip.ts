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
 * rewrite.
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

/** The header shape both the stream proxy and the upgrade tunnel forward — node:http's parsed view. */
export type ForwardedHeaders = ParsedHeaders;

/**
 * Returns the forwarded view of one request's headers with every
 * control-plane authority removed: the client-capability header dropped
 * outright, the capability cookie filtered out of the `Cookie` value
 * (the header itself dropped when it held nothing else). A new object —
 * the input is never mutated.
 */
export function stripControlAuthority(
  headers: ForwardedHeaders,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = { ...headers };
  delete out[CLIENT_CAPABILITY_HEADER];
  const cookie = out.cookie;
  if (typeof cookie === 'string') {
    const stripped = stripCapabilityCookie(cookie);
    if (stripped === undefined) delete out.cookie;
    else out.cookie = stripped;
  } else if (Array.isArray(cookie)) {
    const stripped = cookie
      .map((value) => stripCapabilityCookie(value))
      .filter((value): value is string => value !== undefined);
    if (stripped.length === 0) delete out.cookie;
    else if (stripped.length === 1) out.cookie = stripped[0];
    else out.cookie = stripped;
  }
  return out;
}
