/**
 * The virtual-host routing state machine (#233, F1; ADR-0005 origin
 * contract, ADR-0006 §1 routing, ADR-0007 "Route only the neutral
 * launcher or one exact active project hostname"): which virtual hosts
 * exist on the one loopback origin at this instant. Pure bookkeeping —
 * grant, revoke, resolve over an exact-hostname table; the listener
 * composition and socket authority live in {@link ./origin-listener.ts}.
 *
 * The invariants the ticket pins:
 * - **One active project lease** — a second grant while one is active is
 *   refused (`lease-occupied`): ADR-0006 §4's commit revokes the old
 *   host before granting candidate authority, so the refusal forces the
 *   caller onto the switch protocol instead of silent coexistence.
 * - **Exact-hostname routing** — the launcher host or the exact active
 *   project-key hostname, nothing else: no wildcard, no suffix, no
 *   case-mismatched variant survives (matching is ASCII-case-insensitive
 *   per HTTP host semantics; a trailing dot never reaches here).
 * - **Retired hosts stay retired** — a hostname granted once and revoked
 *   answers `retired-host` (421) rather than `unknown-host`, for the
 *   whole listener lifetime: an old tab after an A-to-B-to-A cycle hits
 *   the CURRENT lease or the 421, never a resurrected old route.
 */

import { type ProjectKey, projectKeySchema } from '@wojciechpiskorz/astroix-protocol';
import {
  type HostRejectionReason,
  LAUNCHER_HOSTNAME,
  parseHostHeader,
  projectHostname,
} from './virtual-hosts.ts';

/** One request's Host evidence as the raw header pairs carry it — duplicates visible, values unparsed. */
export interface HostEvidence {
  /** The single Host value; `undefined` when absent or when the count is not exactly one. */
  readonly hostValue: string | undefined;
  /** How many Host header pairs the request carried (RFC 7230 §5.4: exactly one). */
  readonly hostHeaderCount: number;
}

/** The routing decision for one request: the launcher, the active project, or a refusal class. */
export type HostRouteDecision =
  | { readonly kind: 'launcher' }
  | { readonly kind: 'project'; readonly projectKey: ProjectKey }
  | { readonly kind: 'retired-host' }
  | { readonly kind: 'unknown-host' }
  | { readonly kind: 'rejected'; readonly reason: HostRejectionReason };

/** Why a grant was refused — sanitized vocabulary only. */
export type HostGrantRefusalReason = 'lease-occupied' | 'invalid-project-key';

/** The grant outcome: the admitted hostname, or the refusal reason. */
export type HostGrantResult =
  | { readonly kind: 'granted'; readonly hostname: string }
  | { readonly kind: 'refused'; readonly reason: HostGrantRefusalReason };

export interface HostRouter {
  /** The routing decision for one request's Host evidence — the listener's only request-side authority. */
  resolve(evidence: HostEvidence): HostRouteDecision;
  /** Admits one project virtual host; refused while another lease is active or for a malformed key. */
  grant(projectKey: string): HostGrantResult;
  /** Retires the active lease's host; true when an active lease was retired, false when none was active. */
  revoke(projectKey: string): boolean;
  /** The active lease's project key, or null while the launcher is the only routable host. */
  readonly activeProjectKey: ProjectKey | null;
}

/** Builds one router bound to the listener's port — the port the Host header must carry when it carries one. */
export function createHostRouter(options: { readonly expectedPort: number }): HostRouter {
  let active: ProjectKey | null = null;
  const everGranted = new Set<string>();
  return {
    get activeProjectKey(): ProjectKey | null {
      return active;
    },
    resolve: (evidence) => {
      const parsed = parseHostHeader({
        value: evidence.hostValue,
        count: evidence.hostHeaderCount,
        expectedPort: options.expectedPort,
      });
      if (parsed.kind === 'rejected') return parsed;
      if (parsed.hostname === LAUNCHER_HOSTNAME) return { kind: 'launcher' };
      if (active !== null && parsed.hostname === projectHostname(active)) {
        return { kind: 'project', projectKey: active };
      }
      return everGranted.has(parsed.hostname) ? { kind: 'retired-host' } : { kind: 'unknown-host' };
    },
    grant: (projectKey) => {
      const key = projectKeySchema.safeParse(projectKey);
      if (!key.success) return { kind: 'refused', reason: 'invalid-project-key' };
      if (active !== null) return { kind: 'refused', reason: 'lease-occupied' };
      active = key.data;
      const hostname = projectHostname(key.data);
      everGranted.add(hostname);
      return { kind: 'granted', hostname };
    },
    revoke: (projectKey) => {
      if (active === null || active !== projectKey) return false;
      active = null;
      return true;
    },
  };
}
