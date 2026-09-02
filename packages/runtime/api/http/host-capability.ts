import { randomBytes } from 'node:crypto';
import { LIMITS, type ProjectKey } from '@wojciechpiskorz/astroix-protocol';
import { sameSecret } from './secret-compare.ts';

/**
 * The host capability — the origin-wide request authority (#234, F2;
 * ADR-0006 §3 "Request authority is a separate random 256-bit
 * capability", §7 "the correct host capability"): one minted secret per
 * host (the launcher and every project activation receive DIFFERENT
 * capabilities), delivered as a host-only `HttpOnly` cookie with
 * `Path=/`, verified at dispatch, and revoked with the session it
 * belongs to. The cookie law is absolute and enforced by shape here:
 * the capability exists only as a cookie value and a table entry — it
 * never appears in a URL, a JSON body, an event, a log, or a JavaScript
 * value, and this module never logs and never serializes a capability
 * into anything but the `Set-Cookie` header the composition hands the
 * page (ADR-0006 §3).
 *
 * Comparison is timing-safe over SHA-256 digests (`./secret-compare.ts`,
 * the surface's one comparator) — equal-length buffers, no early exit,
 * no length oracle. Pure table + crypto only; the Electron document
 * binding that decides WHO holds editor authority is the client-binding
 * seam (`./client-bindings.ts`) and its host lane (#246).
 */

/** The capability cookie's name — `__astroix_host`, never sent anywhere else. */
export const CAPABILITY_COOKIE_NAME = '__astroix_host';

/** What `verify` compared against — the host class the request arrived on, project scoped by key. */
export type CapabilityHost =
  | { readonly host: 'launcher' }
  | { readonly host: 'project'; readonly projectKey: ProjectKey };

/** A capability host's table key — `'launcher'` or `'project/<key>'`; internal, never public vocabulary. */
function capabilityKey(target: CapabilityHost): string {
  return target.host === 'launcher' ? 'launcher' : `project/${target.projectKey}`;
}

/** Mints one fresh 256-bit capability (ADR-0006 §3; `LIMITS.requestCapabilityBits`) as lowercase hex. */
export function mintHostCapability(): string {
  return randomBytes(LIMITS.requestCapabilityBits / 8).toString('hex');
}

/**
 * The `Set-Cookie` value the composition delivers a capability with:
 * host-only (no `Domain` attribute), `HttpOnly` (invisible to
 * JavaScript), `Path=/` (required because Vite HMR upgrades live outside
 * the reserved namespace — ADR-0006 §3). Exactly these attributes — no
 * more, no fewer; `SameSite` stays at the Lax default so the top-level
 * `location.replace()` of a commit still carries the fresh cookie.
 */
export function hostCapabilitySetCookie(capability: string): string {
  return `${CAPABILITY_COOKIE_NAME}=${capability}; Path=/; HttpOnly`;
}

/** The parsed cookie-jar view of one `Cookie` header: per-name counts (duplicates visible) and last values. */
export interface CookieJar {
  readonly counts: Readonly<Record<string, number>>;
  readonly values: Readonly<Record<string, string>>;
}

/** Parses one `Cookie` header value into a jar — tolerant of spacing, strict about pair shape. */
export function parseCookieHeader(header: string): CookieJar {
  const counts: Record<string, number> = {};
  const values: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name.length === 0) continue;
    counts[name] = (counts[name] ?? 0) + 1;
    values[name] = part.slice(eq + 1).trim();
  }
  return { counts, values };
}

/** What the Cookie header said about the capability cookie — a smuggle-shaped duplicate is its own refusal. */
export type CapabilityExtraction =
  | { readonly kind: 'present'; readonly value: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'ambiguous' };

/** Extracts the capability cookie from one `Cookie` header value. */
export function capabilityFromCookieHeader(header: string | undefined): CapabilityExtraction {
  if (header === undefined || header.length === 0) return { kind: 'absent' };
  const jar = parseCookieHeader(header);
  if ((jar.counts[CAPABILITY_COOKIE_NAME] ?? 0) > 1) return { kind: 'ambiguous' };
  const value = jar.values[CAPABILITY_COOKIE_NAME];
  return value === undefined ? { kind: 'absent' } : { kind: 'present', value };
}

/** The live host-capability table: mint/verify/revoke per host, current lookup for tests and composition. */
export interface HostCapabilityGrants {
  /** Mints and installs a fresh capability for `target`, revoking any it held — returns the cookie value. */
  mint(target: CapabilityHost): string;
  /** Revokes `target`'s capability — subsequent verifies fail closed. */
  revoke(target: CapabilityHost): void;
  /** True when `presented` is exactly `target`'s current capability — timing-safe, false for missing/revoked/wrong. */
  verify(presented: string | undefined, target: CapabilityHost): boolean;
  /** The current capability for `target`, or null — composition and tests only; never crosses the wire. */
  current(target: CapabilityHost): string | null;
}

/** Builds one grants table — the composition owns its lifetime; a switch revokes and re-mints. */
export function createHostCapabilityGrants(): HostCapabilityGrants {
  const grants = new Map<string, string>();
  return {
    mint: (target) => {
      const capability = mintHostCapability();
      grants.set(capabilityKey(target), capability);
      return capability;
    },
    revoke: (target) => {
      grants.delete(capabilityKey(target));
    },
    verify: (presented, target) => {
      if (presented === undefined || presented.length === 0) return false;
      const expected = grants.get(capabilityKey(target));
      return expected !== undefined && sameSecret(presented, expected);
    },
    current: (target) => grants.get(capabilityKey(target)) ?? null,
  };
}
