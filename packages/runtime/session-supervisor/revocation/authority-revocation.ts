import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { ClientBindings } from '../../api/http/client-bindings.ts';
import type { CapabilityHost, HostCapabilityGrants } from '../../api/http/host-capability.ts';
import type { GrantTable } from '../../edit-authority/grants/grant-table.ts';
import type { SseHub } from '../../sse/sse-hub.ts';
import type { SessionClients } from '../clients/session-clients.ts';

/**
 * The ordered old-authority revocation (#238, F6; ADR-0006 §4 step 5
 * "commit revokes the old host and client capabilities, session
 * authority, routes, streams, and sockets before granting candidate
 * authority"): the one ordered pass that kills every surface the
 * outgoing session's authority lives on, driven ONLY by the targets a
 * {@link SwitchPreparationReceipt} bound at issuance — never by a
 * re-read of what is active (the ticket's migration policy: after
 * command acceptance the receipt's bindings are the truth).
 *
 * The order is this module's law, and it is structural — the plan array
 * below IS the sequence, each step recorded before the next runs:
 *
 * 1. **Streams** (F3's hub): every stream the old session could still
 *    deliver through is ended first — the bound client's stream
 *    (`endForBinding`), the retired host's streams (`endForHost`), and
 *    the old generation's streams (`endForSession`). Ending streams
 *    before the route retires lets each ended stream write its close on
 *    a still-live connection; the retired host's 421 then guarantees no
 *    successor stream can be admitted on the old route.
 * 2. **Routes and sockets** (F1's origin lease): `revoke()` flips the
 *    old project hostname to retired synchronously — from that instant
 *    it answers `421` for everything, the reserved namespace included —
 *    then destroys the lease's tracked HTTP and raw-upgrade sockets and
 *    awaits their closes inside the lease's own bound. This step is
 *    AWAITED: ADR-0005's normal stop order revokes the lease before any
 *    child of the outgoing plane is terminated, and the candidate grant
 *    follows it.
 * 3. **Edit grants** (D4's grant table): every grant of the old pair is
 *    evicted — a stale mutation or undo replaying an old token
 *    afterward reads `unknown-grant`, indistinguishable from
 *    never-issued.
 * 4. **Client capabilities** (both truths of the document-bound client
 *    authority): the supervisor-side registry's session bindings
 *    (F4's `revokeSession`) and the HTTP-side binding the receipt's
 *    client presented (F2's `unbind` — its own doc names session
 *    replacement's unbinding as the revocation). The host lane (#246)
 *    owns the host-driven causes; the commit owns this one.
 * 5. **Host capability** (F2's grants): the old project host capability
 *    dies last among the old-side steps — after it, nothing of the old
 *    session passes admission anywhere.
 *
 * Only then may candidate authority be granted (the caller's grant —
 * F4's `StagedCandidate.commit()`, which mints the successor
 * capability; the ordering proof lives in the focused lane's journal
 * over these same entry points). A throwing entry point is a
 * composition defect, never a reason to stop the sequence: the step is
 * recorded `failed`, the pass continues (revocation began — the
 * transition is irreversible, ADR-0006 §4 step 7), and the report
 * carries the honest `incomplete` outcome for the failure category
 * `revocation` to consume.
 *
 * Deterministic by construction: every surface arrives as an injected
 * structural slice of a landed module (read-only consumption — the hub,
 * the grant table, the client registries, the capability grants), and
 * the one awaited step is the lease's own bounded revocation. The
 * focused tests journal these entry points to prove the order.
 */

/** The old session's project host scope — what the route and capability revocations address. */
export type ProjectHostTarget = { readonly host: 'project'; readonly projectKey: ProjectKey };

/**
 * The origin lease as revocation sees it. F1's `OriginLease` is a
 * structural superset and binds here unchanged.
 */
export interface RoutesTarget {
  /**
   * Retires the route (421 from this instant), destroys the lease's
   * tracked sockets, and settles once their closes are observed inside
   * the lease's own bound — or honestly reports `incomplete`.
   */
  revoke(): Promise<LeaseRevocationView>;
}

/** A lease revocation's honest accounting — counts and outcome only (F1's shape). */
export interface LeaseRevocationView {
  readonly outcome: 'complete' | 'incomplete';
  readonly destroyedSockets: number;
}

/**
 * The never-granted lease's route view (#349): the honest target when a
 * failure aftermath revokes a candidate whose lease was never granted
 * (the adoption died before the route was published) — no route exists,
 * so nothing retires and no socket dies, and the pass's routes step over
 * this view records the complete-nothing accounting. The one view the
 * vocabulary defines for a lease that never existed: compositions
 * consume it instead of fabricating a pass-shaped answer of their own.
 */
export const neverGrantedRoutes: RoutesTarget = Object.freeze({
  revoke: async () => ({ outcome: 'complete' as const, destroyedSockets: 0 }),
});

/**
 * The old-side revocation surfaces — every landed module consumed
 * read-only through the slice the coordinator needs.
 */
export interface RevocationSurfaces {
  /** F3's stream hub: the three revocation scopes the commit drives. */
  readonly streams: Pick<SseHub, 'endForHost' | 'endForSession' | 'endForBinding'>;
  /** D4's grant table: the old session's grant eviction. */
  readonly grants: Pick<GrantTable, 'revokeSession'>;
  /** F4's client registry: the supervisor-side binding truth. */
  readonly clients: Pick<SessionClients, 'revokeSession'>;
  /** F2's HTTP-side binding table: `unbind` is session replacement's revocation there. */
  readonly httpBindings: Pick<ClientBindings, 'unbind'>;
  /** F2's host-capability grants: the old project capability dies here. */
  readonly hostCapabilities: Pick<HostCapabilityGrants, 'revoke'>;
}

/** The five revocation steps, in the one order this module runs them. */
export type RevocationStep =
  | 'streams'
  | 'routes'
  | 'edit-grants'
  | 'client-bindings'
  | 'host-capability';

/** One step's sanitized result — what it revoked, or the honest `failed` marker. */
export type RevocationStepResult =
  | { readonly kind: 'streams-ended'; readonly ended: number }
  | {
      readonly kind: 'lease-revoked';
      readonly lease: 'complete' | 'incomplete';
      readonly destroyedSockets: number;
    }
  | { readonly kind: 'grants-evicted'; readonly evicted: number }
  | { readonly kind: 'bindings-revoked' }
  | { readonly kind: 'capability-revoked' }
  | { readonly kind: 'failed' };

/** One recorded step of the ordered pass. */
export interface RevocationStepOutcome {
  readonly step: RevocationStep;
  readonly result: RevocationStepResult;
}

/** The ordered pass's honest report — complete only when every step ran and the lease closed inside its bound. */
export interface RevocationReport {
  /** The revoked session — the receipt's bound old pair, never a re-read of active state. */
  readonly session: SessionRef;
  /** The five steps, in the order they ran. */
  readonly steps: readonly RevocationStepOutcome[];
  /**
   * `complete` when no entry point threw and the lease observed every
   * destroyed socket's close inside its bound; `incomplete` otherwise —
   * the honest signal behind the `revocation` failure category.
   */
  readonly outcome: 'complete' | 'incomplete';
}

/**
 * The first commit's old-side accounting (#349): no old session
 * existed, so no revocation pass ran. A {@link RevocationReport} claims
 * a pass ran over a receipt's bound old pair — a first commit has
 * neither — so no report shape can tell a first activation's truth;
 * this marker is the honest nothing. Compositions construct the
 * first-commit transition variant instead of fabricating a report.
 */
export type FirstCommitRevocation = { readonly kind: 'first-commit' };

/**
 * The old-side accounting one settled transition preserves: the
 * ordered pass's report (a switch — the receipt's bound old pair), or
 * the first commit's honest nothing (a first activation — there was
 * no old authority to revoke).
 */
export type RevocationAccounting = RevocationReport | FirstCommitRevocation;

/**
 * The one {@link FirstCommitRevocation} value — the fixed template a
 * first activation's failure result preserves (the E6 law's idiom: one
 * frozen value, no free construction).
 */
export const FIRST_COMMIT_REVOCATION: FirstCommitRevocation = Object.freeze({
  kind: 'first-commit',
});

/** What the ordered pass needs — the receipt's bound targets plus the shared surfaces. */
export interface RevokeOldAuthorityInput {
  /** The outgoing session's exact pair (the receipt's binding). */
  readonly session: SessionRef;
  /** The outgoing session's project host scope (the receipt's binding). */
  readonly host: ProjectHostTarget;
  /** The authoritative client's HTTP-side capability — `unbind`'s key (the receipt's binding). */
  readonly clientCapability: string;
  /** The outgoing session's origin lease, bound at receipt issuance (the receipt's binding). */
  readonly routes: RoutesTarget;
  /** The shared revocation surfaces (the composition's singletons). */
  readonly surfaces: RevocationSurfaces;
}

/** Ends every stream the old session could still deliver through — all three scopes, one recorded count. */
function endStreams(input: RevokeOldAuthorityInput): number {
  const bound = input.surfaces.streams.endForBinding(input.clientCapability);
  const host = input.surfaces.streams.endForHost(input.host satisfies CapabilityHost);
  const session = input.surfaces.streams.endForSession(input.session);
  return bound + host + session;
}

/**
 * Runs the one ordered revocation pass. The plan array is the law: the
 * steps run in array order, each recorded before the next begins, and a
 * throwing entry point never stops the sequence.
 */
export async function revokeOldAuthority(
  input: RevokeOldAuthorityInput,
): Promise<RevocationReport> {
  const plan: ReadonlyArray<{
    readonly step: RevocationStep;
    readonly run: () => Promise<RevocationStepResult>;
  }> = [
    {
      step: 'streams',
      run: async () => ({ kind: 'streams-ended', ended: endStreams(input) }),
    },
    {
      step: 'routes',
      run: async () => {
        const lease = await input.routes.revoke();
        return {
          kind: 'lease-revoked',
          lease: lease.outcome,
          destroyedSockets: lease.destroyedSockets,
        };
      },
    },
    {
      step: 'edit-grants',
      run: async () => ({
        kind: 'grants-evicted',
        evicted: input.surfaces.grants.revokeSession(input.session),
      }),
    },
    {
      step: 'client-bindings',
      run: async () => {
        input.surfaces.clients.revokeSession(input.session);
        input.surfaces.httpBindings.unbind(input.clientCapability);
        return { kind: 'bindings-revoked' };
      },
    },
    {
      step: 'host-capability',
      run: async () => {
        input.surfaces.hostCapabilities.revoke(input.host);
        return { kind: 'capability-revoked' };
      },
    },
  ];

  const steps: RevocationStepOutcome[] = [];
  for (const entry of plan) {
    try {
      steps.push({ step: entry.step, result: await entry.run() });
    } catch {
      // A throwing revocation entry point is a composition defect. The
      // pass is fail-continue by law: revocation began, the transition
      // is irreversible, and the report must carry the honest failure.
      steps.push({ step: entry.step, result: { kind: 'failed' } });
    }
  }
  const outcome: 'complete' | 'incomplete' = steps.some(
    (step) =>
      step.result.kind === 'failed' ||
      (step.result.kind === 'lease-revoked' && step.result.lease === 'incomplete'),
  )
    ? 'incomplete'
    : 'complete';
  return { session: input.session, steps, outcome };
}
