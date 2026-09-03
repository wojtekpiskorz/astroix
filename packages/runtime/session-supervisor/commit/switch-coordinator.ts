import { LIMITS, type SessionFailure, type SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { ClientBindings } from '../../api/http/client-bindings.ts';
import type { WriteExecutorHandle } from '../../edit-authority/executor/executor-spawn.ts';
import type { SessionClients } from '../clients/session-clients.ts';
import {
  createHostDrainClock,
  type DrainClock,
  type EditDrain,
  type EditFence,
  type EditFenceState,
} from '../fence/edit-fence.ts';
import type { RevocationReport, RevocationSurfaces } from '../revocation/authority-revocation.ts';
import { revokeOldAuthority } from '../revocation/authority-revocation.ts';
import type { StagedCandidate } from '../staging/session-supervisor.ts';
import {
  type AuthoritativeClient,
  createReceiptLedger,
  type ExecutorExitView,
  type PreparationResult,
  type ReceiptLedger,
  type SwitchPreparationReceipt,
  type SwitchTarget,
} from './switch-receipt.ts';

/**
 * The switch coordinator (#238, F6; ADR-0006 §4 steps 4–5 and §9's
 * coordinator sentence — "a native switch coordinator … consumes the
 * receipt through candidate commit or deactivation"): the composition
 * that prepares one transition, mints its one-use
 * {@link SwitchPreparationReceipt}, and consumes it at the commit
 * linearization point — the ordered revocation of every old-side
 * surface BEFORE the candidate grant.
 *
 * The laws this machine holds:
 *
 * - **The §9 reconciliation (settled here)**: F4 (#317) landed
 *   `StagedCandidate.commit()` as a synchronous PARAMLESS state-side
 *   linearization — staging cannot validate a proof it never minted.
 *   This coordinator is the consuming side §9 line 151 sketches: it
 *   validates and spends the receipt, then drives the paramless
 *   candidate commit as the grant. Two seams, one linearization — the
 *   receipt's consumption is the irreversible instant; the candidate
 *   commit that follows is the state swap it authorizes.
 * - **The bindings are the truth** (the ticket's migration policy):
 *   every revocation addresses what the receipt froze at issuance —
 *   the exact old pair, its host scope, its origin lease, its
 *   authoritative client. Nothing re-reads "what is active" after
 *   acceptance; a candidate that is not the bound one refuses without
 *   spending the receipt.
 * - **Normal preparation** (§4 step 5): a receipt is minted only over
 *   the TERMINAL drain report of a clean drain — the sealed `drained`
 *   verdict, read off the report (never the fence state), on a fence
 *   still sitting at that verdict (resume-before-receipt is refused: a
 *   resumed fence may have accepted new work after the report, and
 *   certifying it would lie). A `failed` terminal report is §4 step
 *   3's abort path (rollback + resume, F5's landed composition), never
 *   a receipt; a `timed-out` verdict is sealed — late terminality
 *   never rewrites it — so the normal variant refuses it and the
 *   forced variant owns that fence.
 * - **Forced preparation** (§4 step 4): only a fence in the timed-out
 *   states (`timed-out`, or its sealed continuation
 *   `terminal-after-timeout`) may force. The coordinator terminates
 *   the exact write executor and OBSERVES its exit — D5's process-lane
 *   idiom, raced against the protocol's 2-second forced-reap deadline
 *   on the injected clock. An observed exit mints the forced receipt;
 *   an incomplete reap mints NOTHING (`incomplete-reap` — the caller
 *   rolls the candidate back under F4's reason of the same name; the
 *   tombstone and blocked no-active state are the composition's).
 * - **Consumption is the linearization** (§4 step 5): every binding
 *   check runs BEFORE the one-use flip, so a refusal linearizes
 *   nothing and spends nothing. After the flip the pass is
 *   irreversible — the ordered revocation runs fail-continue, and a
 *   candidate grant that then refuses lands in the `failed` result
 *   (category `revocation`, no active session) for F7's irreversible
 *   post-commit path — never a silent rollback of revoked authority.
 *
 * Deterministic by construction: every surface is an injected
 * structural slice of a landed module (read-only consumption), and the
 * one time dependency — the forced-reap bound — is the injected
 * {@link DrainClock} (the F5 idiom; the focused tests never arm a real
 * timer).
 */

/** The write executor as the forced preparation sees it — D5's handle is a structural superset. */
export type ForcedExecutor = Pick<WriteExecutorHandle, 'kill' | 'exited'>;

/** Why a preparation refused to mint — sanitized vocabulary only, never a value. */
export type PreparationRefusal =
  /** The sealed terminal `failed` report — §4 step 3's abort path (rollback + resume) owns it, never a receipt. */
  | 'drain-failed'
  /** The sealed `timed-out` verdict — the forced variant or more waiting; late terminality never rewrites it. */
  | 'drain-timed-out'
  /** The fence was resumed before the receipt (or otherwise left the certified state) — the certification would lie. */
  | 'fence-resumed'
  /** The bound client is not the live authoritative editor of the old pair. */
  | 'client-not-authoritative'
  /** Forced preparation on a fence not in the timed-out states. */
  | 'fence-not-timed-out'
  /** A deactivation target minted without the outgoing run's stop seam. */
  | 'deactivation-without-stop';

/** `prepareNormal`'s answer: the minted receipt, or the structured refusal. */
export type NormalPreparation =
  | { readonly kind: 'prepared'; readonly receipt: SwitchPreparationReceipt }
  | { readonly kind: 'refused'; readonly reason: PreparationRefusal };

/** `prepareForced`'s answer: the minted receipt, a refusal, or the reap that never observed the exit (NO receipt). */
export type ForcedPreparation =
  | { readonly kind: 'prepared'; readonly receipt: SwitchPreparationReceipt }
  | { readonly kind: 'refused'; readonly reason: PreparationRefusal }
  | { readonly kind: 'incomplete-reap' };

/** What one preparation freezes — the mint input (the receipt's bindings-to-be). */
export interface SwitchPreparationInput {
  readonly oldSession: SessionRef;
  readonly target: SwitchTarget;
  readonly client: AuthoritativeClient;
  readonly fence: EditFence;
  readonly drain: EditDrain;
  readonly host: Parameters<typeof revokeOldAuthority>[0]['host'];
  readonly routes: Parameters<typeof revokeOldAuthority>[0]['routes'];
  /** Deactivation only: stops the outgoing run after revocation. */
  readonly stopOldRun?: () => void;
}

/** Why a commit or deactivation refused — sanitized vocabulary only; nothing was revoked, nothing spent. */
export type ReceiptRejection =
  | 'unknown-receipt'
  | 'already-consumed'
  | 'candidate-mismatch'
  | 'not-a-replacement'
  | 'not-a-deactivation'
  | 'fence-resumed';

/**
 * The committed transition result: the grant or the deactivation with
 * its revocation report, the irreversible post-revocation failure, or
 * the pre-linearization rejection.
 */
export type CommittedTransition =
  | {
      readonly kind: 'committed';
      readonly committed: SessionRef;
      readonly revoked: RevocationReport;
    }
  | {
      readonly kind: 'deactivated';
      readonly deactivated: SessionRef;
      readonly revoked: RevocationReport;
    }
  | {
      /** Irreversible (§4 step 7): authority was revoked and the grant or stop then failed — no active session; F7's completion owns the aftermath. */
      readonly kind: 'failed';
      readonly failure: SessionFailure;
      readonly revoked: RevocationReport;
    }
  | { readonly kind: 'rejected'; readonly reason: ReceiptRejection };

/** Construction options — the shared revocation surfaces plus the forced-reap clock. */
export interface SwitchCoordinatorOptions extends RevocationSurfaces {
  /** The supervisor-side client registry — the mint validates the authoritative editor through it. */
  readonly clients: Pick<SessionClients, 'authorize' | 'revokeSession'>;
  /** The HTTP-side binding table — the mint validates and the revocation unbinds. */
  readonly httpBindings: Pick<ClientBindings, 'resolve' | 'unbind'>;
  /** The forced-reap clock; defaults to the host timer (the F5 drain-clock idiom, never a second time source). */
  readonly reapClock?: DrainClock;
}

/** The switch coordinator's surface. */
export interface SwitchCoordinator {
  /** Mints the normal receipt over the drain's sealed terminal verdict. */
  prepareNormal(input: SwitchPreparationInput): Promise<NormalPreparation>;
  /**
   * Terminates the exact write executor, observes its exit inside the
   * forced-reap bound, and mints the forced receipt — or reports the
   * incomplete reap that mints nothing.
   */
  prepareForced(
    input: SwitchPreparationInput & { readonly executor: ForcedExecutor },
  ): Promise<ForcedPreparation>;
  /**
   * Consumes the receipt (the linearization), revokes every old-side
   * authority in order, then grants the bound candidate through its
   * paramless commit.
   */
  commit(
    receipt: SwitchPreparationReceipt,
    candidate: StagedCandidate,
  ): Promise<CommittedTransition>;
  /** Consumes the receipt, revokes every old-side authority in order, and stops the outgoing run — no successor. */
  deactivate(receipt: SwitchPreparationReceipt): Promise<CommittedTransition>;
}

/** The fixed failure behind the irreversible `failed` result — the E6 law, one template, no free text. */
const POST_REVOCATION_FAILURE: SessionFailure = {
  category: 'revocation',
  message: 'the session commit failed after the outgoing authority was revoked',
};

/** Field-wise pair equality — `runtimeEpoch` and `generation` exact (the codebase idiom). */
function sameSession(left: SessionRef, right: SessionRef): boolean {
  return left.runtimeEpoch === right.runtimeEpoch && left.generation === right.generation;
}

/** True while the fence still sits at the state its preparation certified — a resumed fence fails this. */
function fenceStillCertified(preparation: PreparationResult, state: EditFenceState): boolean {
  if (preparation.kind === 'normal') return state === 'drained';
  return state === 'timed-out' || state === 'terminal-after-timeout';
}

/**
 * Races the executor's exit observation against the forced-reap
 * deadline: the observed exit wins, the deadline reports `null` (an
 * incomplete reap), and a rejecting observation is an un-observed exit
 * — fail closed, never a hung or guessed receipt.
 */
async function observeForcedExit(
  exited: Promise<ExecutorExitView>,
  clock: DrainClock,
): Promise<ExecutorExitView | null> {
  return await new Promise((resolve) => {
    const disarm = clock.delay(LIMITS.forcedReapDeadlineMs, () => resolve(null));
    exited.then(
      (exit) => {
        disarm();
        resolve(exit);
      },
      () => {
        disarm();
        resolve(null);
      },
    );
  });
}

/** Builds the switch coordinator over the injected surfaces. */
export function createSwitchCoordinator(options: SwitchCoordinatorOptions): SwitchCoordinator {
  const ledger: ReceiptLedger = createReceiptLedger();
  const clock = options.reapClock ?? createHostDrainClock();
  const surfaces: RevocationSurfaces = options;

  /** The authoritative-client law: both truths of the editor's capability must name the old pair. */
  const clientIsAuthoritative = (input: SwitchPreparationInput): boolean => {
    const authorized = options.clients.authorize({
      capability: input.client.capability,
      document: input.client.document,
      sessionRef: input.oldSession,
      role: 'editor',
    });
    if (authorized.kind !== 'authorized') return false;
    const binding = options.httpBindings.resolve(input.client.httpCapability);
    return (
      binding !== null &&
      binding.role === 'editor' &&
      binding.host === 'project' &&
      binding.sessionRef !== null &&
      sameSession(binding.sessionRef, input.oldSession)
    );
  };

  /** The target's own sanity: a deactivation must carry the outgoing stop seam. */
  const targetIsWellFormed = (input: SwitchPreparationInput): boolean =>
    input.target.kind !== 'deactivation' || input.stopOldRun !== undefined;

  const coordinator: SwitchCoordinator = {
    prepareNormal: async (input) => {
      if (!clientIsAuthoritative(input)) {
        return { kind: 'refused', reason: 'client-not-authoritative' };
      }
      if (!targetIsWellFormed(input)) {
        return { kind: 'refused', reason: 'deactivation-without-stop' };
      }
      // The sealed verdict first — the receipt reads the report, never the fence state.
      const report = await input.drain.outcome;
      if (report.kind === 'timed-out') return { kind: 'refused', reason: 'drain-timed-out' };
      if (report.kind === 'failed') return { kind: 'refused', reason: 'drain-failed' };
      // …and the fence must still sit at that verdict: a resumed fence
      // may have accepted new work after the report was sealed.
      if (input.fence.state !== 'drained') {
        return { kind: 'refused', reason: 'fence-resumed' };
      }
      return {
        kind: 'prepared',
        receipt: ledger.mint({
          oldSession: input.oldSession,
          target: input.target,
          client: input.client,
          fence: input.fence,
          drain: input.drain,
          preparation: { kind: 'normal', report },
          host: input.host,
          routes: input.routes,
          stopOldRun: input.stopOldRun ?? null,
        }),
      };
    },

    prepareForced: async (input) => {
      if (!clientIsAuthoritative(input)) {
        return { kind: 'refused', reason: 'client-not-authoritative' };
      }
      if (!targetIsWellFormed(input)) {
        return { kind: 'refused', reason: 'deactivation-without-stop' };
      }
      const state = input.fence.state;
      if (state !== 'timed-out' && state !== 'terminal-after-timeout') {
        return { kind: 'refused', reason: 'fence-not-timed-out' };
      }
      // Terminate the exact disposable executor and observe its exit —
      // the kill is fired, never awaited ahead of the race (the stop
      // promise is unbounded; the exit observation is the bounded one).
      void input.executor.kill().catch(() => {});
      const exit = await observeForcedExit(input.executor.exited, clock);
      if (exit === null) return { kind: 'incomplete-reap' };
      return {
        kind: 'prepared',
        receipt: ledger.mint({
          oldSession: input.oldSession,
          target: input.target,
          client: input.client,
          fence: input.fence,
          drain: input.drain,
          preparation: { kind: 'forced', exit },
          host: input.host,
          routes: input.routes,
          stopOldRun: input.stopOldRun ?? null,
        }),
      };
    },

    commit: async (receipt, candidate) => {
      // Every binding check precedes the one-use flip: a refusal
      // linearizes nothing and spends nothing.
      const lookup = ledger.lookup(receipt);
      if (lookup.kind !== 'valid') {
        return { kind: 'rejected', reason: lookup.kind };
      }
      const bindings = lookup.bindings;
      if (bindings.target.kind !== 'replacement') {
        return { kind: 'rejected', reason: 'not-a-replacement' };
      }
      if (!sameSession(bindings.target.candidate, candidate.ref)) {
        return { kind: 'rejected', reason: 'candidate-mismatch' };
      }
      if (!fenceStillCertified(bindings.preparation, bindings.fence.state)) {
        return { kind: 'rejected', reason: 'fence-resumed' };
      }
      if (!ledger.consume(receipt)) {
        return { kind: 'rejected', reason: 'already-consumed' };
      }
      // THE LINEARIZATION: the receipt is spent. From here the pass is
      // irreversible — the ordered revocation runs, then the grant.
      const revoked = await revokeOldAuthority({
        session: bindings.oldSession,
        host: bindings.host,
        clientCapability: bindings.client.httpCapability,
        routes: bindings.routes,
        surfaces,
      });
      try {
        const granted = await candidate.commit();
        return { kind: 'committed', committed: granted.committed, revoked };
      } catch {
        // The grant refused after revocation: irreversible (§4 step
        // 7) — report the failure with the revocation report; the
        // candidate's own machine has already converged its orphaned
        // run, and F7's completion owns the aftermath.
        return { kind: 'failed', failure: POST_REVOCATION_FAILURE, revoked };
      }
    },

    deactivate: async (receipt) => {
      const lookup = ledger.lookup(receipt);
      if (lookup.kind !== 'valid') {
        return { kind: 'rejected', reason: lookup.kind };
      }
      const bindings = lookup.bindings;
      if (bindings.target.kind !== 'deactivation') {
        return { kind: 'rejected', reason: 'not-a-deactivation' };
      }
      if (!fenceStillCertified(bindings.preparation, bindings.fence.state)) {
        return { kind: 'rejected', reason: 'fence-resumed' };
      }
      if (!ledger.consume(receipt)) {
        return { kind: 'rejected', reason: 'already-consumed' };
      }
      const revoked = await revokeOldAuthority({
        session: bindings.oldSession,
        host: bindings.host,
        clientCapability: bindings.client.httpCapability,
        routes: bindings.routes,
        surfaces,
      });
      // The shutdown transition's own stop: authority is revoked, the
      // outgoing run stops now; its close report is the completion
      // lane's (F7), never this result's.
      try {
        bindings.stopOldRun?.();
      } catch {
        return { kind: 'failed', failure: POST_REVOCATION_FAILURE, revoked };
      }
      return { kind: 'deactivated', deactivated: bindings.oldSession, revoked };
    },
  };
  return coordinator;
}
