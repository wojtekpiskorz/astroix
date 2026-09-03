import { CLIENT_CAPABILITY_HEADER } from '@wojciechpiskorz/astroix-runtime/api/http';

/**
 * The client-capability injection policy (#246, H4; ADR-0006 §3
 * "injected after JavaScript request construction. Astroix overwrites
 * any same-named renderer header"): the pure laws the Electron
 * `webRequest` seam applies. Electron fires `onBeforeSendHeaders` AFTER
 * the renderer's JavaScript has constructed the request — fetch/XHR
 * headers included — so rewriting there is exactly "after construction";
 * whatever the renderer spelled (`X-ASTROIX-CLIENT`, `x-astroix-client`,
 * any casing) dies and at most one canonical header leaves.
 *
 * The two laws, both fail-closed:
 * - a bound document at an OWNED origin carries exactly one client
 *   header — the live capability, never a renderer value;
 * - everything else (a foreign origin, an unbound or invalidated
 *   document, a request with no webContents identity) carries NONE: the
 *   renderer's same-named header is deleted outright, so a forged value
 *   never leaves the host toward ANY server, and the capability never
 *   leaks beyond the origins that validate it.
 *
 * Pure header surgery — no Electron import; the adapter over the real
 * `session.webRequest` is `./web-request-injection.ts`, and its
 * real-Electron truth is the `e2e/desktop` lane.
 */

/**
 * Rewrites one request's headers for the client-capability law: every
 * case-insensitive spelling of the client header is removed, and the
 * canonical lowercase name is set to `injectable` when one exists. A new
 * object — the input is never mutated; every other header rides verbatim
 * (name bytes included, so Chromium's casing survives untouched, and
 * array-valued headers stay array-valued — the seam's real shape).
 */
export function rewriteClientCapabilityHeader(
  headers: Readonly<Record<string, string | string[]>>,
  injectable: string | null,
): Record<string, string | string[]> {
  const rewritten: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === CLIENT_CAPABILITY_HEADER) continue;
    rewritten[name] = value;
  }
  if (injectable !== null && injectable.length > 0) {
    rewritten[CLIENT_CAPABILITY_HEADER] = injectable;
  }
  return rewritten;
}

/**
 * True when `url` belongs to an origin the control plane owns (the
 * launcher or the active project host — the only origins that validate
 * the client capability). Exact `URL.origin` membership, lowercased; an
 * unparseable URL is never owned (fail closed, never a suffix or host
 * guess — `http://evil.localhost:1/` is not `http://a.localhost:4321`).
 */
export function originAllowsInjection(url: string, ownedOrigins: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ownedOrigins.has(parsed.origin.toLowerCase());
}
