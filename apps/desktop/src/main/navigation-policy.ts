/**
 * The top-level navigation policy (#243, H1; ADR-0006 §5's navigation
 * currency, ADR-0004's boundary): a pure decision over the set of
 * origins the host has approved — the neutral document (`about:blank`,
 * the placeholder until the control-plane composition lane serves the
 * launcher) and the loopback origins the composition grants later (the
 * launcher origin, the active project's `http://<project-key>.localhost`
 * origin). Everything else — every `https:`, `file:`, `data:`,
 * `chrome:`, and lookalike/prefix origin — is denied: `will-navigate`
 * preventDefault and `setWindowOpenHandler` deny (popups are never
 * navigation's escape hatch).
 *
 * Exact-origin membership, never substring: `https://evil.example` is
 * not approved by an approved `https://evil` prefix, and a port-bearing
 * lookalike is a different origin. The policy holds no URL parser of
 * its own — an approved target is an exact origin string the host
 * granted, so a malformed target simply matches nothing.
 */

/** The neutral placeholder document — the only always-approved target. */
export const NEUTRAL_DOCUMENT_URL = 'about:blank';

/** What a proposed top-level target resolves to. */
export type NavigationDecision = 'allow' | 'deny';

/** The mutable approval set: origins granted by the composition (launcher, active project). */
export interface NavigationApprovals {
  /** Grants one exact origin for top-level navigation (idempotent). */
  approveOrigin(origin: string): void;
  /** Drops one approved origin (an origin lease was revoked). */
  revokeOrigin(origin: string): void;
  /** The decision for one proposed top-level target URL. */
  decideNavigation(targetUrl: string): NavigationDecision;
  /** The approved origin set, in grant order (the smoke lane's evidence). */
  approvedOrigins(): readonly string[];
}

/** Builds the policy over its initial (possibly empty) approval set. */
export function createNavigationPolicy(initial: readonly string[] = []): NavigationApprovals {
  const approved = new Set<string>(initial);
  return {
    approveOrigin: (origin) => {
      approved.add(origin);
    },
    revokeOrigin: (origin) => {
      approved.delete(origin);
    },
    decideNavigation: (targetUrl) => {
      if (targetUrl === NEUTRAL_DOCUMENT_URL) return 'allow';
      return approved.has(originOf(targetUrl)) ? 'allow' : 'deny';
    },
    approvedOrigins: () => [...approved],
  };
}

/**
 * The origin of one target URL for membership purposes: the exact
 * `scheme://host[:port]` string — everything before the first `/` after
 * the scheme separator. A URL with no path carries itself.
 */
function originOf(targetUrl: string): string {
  const scheme = schemeOf(targetUrl);
  const separator = `${scheme}//`;
  if (!targetUrl.startsWith(separator)) return targetUrl;
  const rest = targetUrl.slice(separator.length);
  const pathStart = rest.indexOf('/');
  return pathStart === -1 ? targetUrl : targetUrl.slice(0, separator.length + pathStart);
}

/** The scheme prefix of one URL, lowercased — `about:` for the neutral document, `http:` for loopback origins. */
function schemeOf(targetUrl: string): string {
  const colon = targetUrl.indexOf(':');
  return colon === -1 ? '' : `${targetUrl.slice(0, colon).toLowerCase()}:`;
}
