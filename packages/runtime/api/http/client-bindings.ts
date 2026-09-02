import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { ClientRole, VirtualHostClass } from './command-routes.ts';

/**
 * Document-bound client authority (#234, F2; ADR-0006 §3 "the
 * origin-wide cookie is necessary but not sufficient for edit
 * authority: Electron also binds a random per-document client
 * capability"): the live table binding one random client capability to
 * its document's role, host, and exact `SessionRef`. This is the
 * server-side half of the seam — the dispatch validates presented
 * bindings against it, and the Electron host lane (#246) owns WHEN a
 * binding exists: it injects the capability after renderer request
 * construction, overwrites any same-named renderer header, and revokes
 * on navigation, renderer loss, debugger detach, or session
 * replacement (unbinding here is that revocation).
 *
 * Exactly one editor and up to three diagnostics are server-enforced
 * (ADR-0006 §3/§7) — `bind` refuses a second editor and a fourth
 * diagnostic, so the caps can never be outlived. The launcher document
 * binds role `launcher` with no `SessionRef` (it spans sessions); an
 * editor or diagnostic binding always carries the exact pair it was
 * bound at, and a stale pair never upgrades (a new generation needs a
 * new binding). Comparison is timing-safe; the capability never
 * crosses the wire in any direction but the injected header.
 */

/** The header the Electron host injects after JavaScript request construction — this seam's name is the contract (#246). */
export const CLIENT_CAPABILITY_HEADER = 'x-astroix-client';

/** One live document binding: what the presented capability is entitled to. */
export interface ClientBinding {
  readonly role: ClientRole;
  /** The virtual host class this document lives on — a binding never crosses hosts. */
  readonly host: VirtualHostClass;
  /** The exact pair the binding was minted at — `null` only for the session-spanning launcher role. */
  readonly sessionRef: SessionRef | null;
}

/** What `bind` refused — sanitized vocabulary only. */
export type BindingRefusalReason = 'second-editor' | 'fourth-diagnostic';

/** The live binding table. */
export interface ClientBindings {
  /** Installs one binding; refuses past the server-enforced role caps (one editor, three diagnostics). */
  bind(input: {
    readonly role: ClientRole;
    readonly host: VirtualHostClass;
    readonly sessionRef: SessionRef | null;
    readonly capability?: string;
  }):
    | { readonly kind: 'bound'; readonly capability: string }
    | { readonly kind: 'refused'; readonly reason: BindingRefusalReason };
  /** Revokes the binding a capability names — idempotent; nothing resolves afterwards. */
  unbind(capability: string): void;
  /** The live binding a presented capability names, or null — timing-safe over every live entry. */
  resolve(presented: string | undefined): ClientBinding | null;
  /** The live binding count per role — composition and tests only. */
  counts(): { readonly editor: number; readonly diagnostic: number; readonly launcher: number };
}

/** Digests to fixed length before the timing-safe compare — no length oracle, no early exit. */
function sameCapability(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Builds one binding table — the composition owns its lifetime alongside the host capabilities. */
export function createClientBindings(): ClientBindings {
  const live = new Map<string, ClientBinding>();
  const countByRole = (): Record<ClientRole, number> => {
    const counts: Record<ClientRole, number> = { launcher: 0, editor: 0, diagnostic: 0 };
    for (const binding of live.values()) counts[binding.role] += 1;
    return counts;
  };
  return {
    bind: (input) => {
      const counts = countByRole();
      if (input.role === 'editor' && counts.editor >= 1) {
        return { kind: 'refused', reason: 'second-editor' };
      }
      if (input.role === 'diagnostic' && counts.diagnostic >= 3) {
        return { kind: 'refused', reason: 'fourth-diagnostic' };
      }
      const capability = input.capability ?? randomBytes(32).toString('hex');
      live.set(capability, { role: input.role, host: input.host, sessionRef: input.sessionRef });
      return { kind: 'bound', capability };
    },
    unbind: (capability) => {
      live.delete(capability);
    },
    resolve: (presented) => {
      if (presented === undefined || presented.length === 0) return null;
      for (const [capability, binding] of live) {
        if (sameCapability(presented, capability)) return binding;
      }
      return null;
    },
    counts: () => countByRole(),
  };
}
