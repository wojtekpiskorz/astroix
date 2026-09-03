import type { SessionFailure, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import type { ClientDocument } from '../clients/session-clients.ts';
import type {
  ProjectHostTarget,
  RevocationAccounting,
  RevocationReport,
  RoutesTarget,
} from '../revocation/authority-revocation.ts';

/**
 * The completion result shapes (#239, F7; ADR-0006 §4 step 6–7 and §9
 * `completeReplacement`'s `CompletionResult`): the vocabulary of the
 * last transition step — the host-observed completion and its
 * irreversible failure aftermath. Pure types plus the one fixed failure
 * template; the driver lives in the sibling
 * `./replacement-completion.ts`.
 */

/**
 * The host-observed completion seams (ADR-0006 §4 step 6: "the native
 * host observes and reports each asynchronous outcome"): the contract
 * the Electron host lanes satisfy, modeled as observed-promise seams —
 * the E8 declared-seam precedent (the host surfaces arrive with the
 * host lanes; this is the observed-completion contract they will
 * satisfy). Each observation resolves when the host OBSERVES the
 * outcome and rejects when the host observes its failure; settling is
 * the host's contract (this seam declares it, the host lanes own the
 * patience — no completion deadline is chartered).
 */
export interface HostCompletionObservations {
  /**
   * Activation: the exact main-frame ready handshake — the host has
   * reset the client, performed the top-level `location.replace()` to
   * the project app, and now observes THE main frame's ready handshake
   * (the exact target document's frame, never any frame's load).
   */
  mainFrameReady(): Promise<void>;
  /**
   * Deactivation (and the failure path's launcher show): the top level
   * was replaced with the launcher and the host observes launcher
   * readiness.
   */
  launcherReady(): Promise<void>;
  /**
   * Quit: the target's close — a CLOSE observation, structurally
   * distinct from both ready handshakes: the quit completion never
   * depends on any navigation event, and the driver's quit path never
   * touches the two navigation seams above.
   */
  targetClosed(): Promise<void>;
}

/**
 * The authoritative-client identity a transition's receipt froze at
 * issuance — the fields `switch-receipt.ts` names THIS completion as
 * the consumer of ("`client`'s document and supervisor-side capability
 * are the issuance-frozen identity of the authoritative editor the AC
 * binds — F7's completion reports them"): the completion result's
 * target reference (§7: "lifecycle results carry the target reference
 * and current snapshot"). Control-plane currency — never crosses the
 * wire.
 */
export interface CompletionClientIdentity {
  /** The exact document the authoritative editor lived at (the receipt's frozen binding). */
  readonly document: ClientDocument;
  /** The supervisor-side capability of that editor (the receipt's frozen binding). */
  readonly capability: string;
}

/**
 * The granted candidate as the failure aftermath sees it: its own
 * revocation targets (the same five-surface pass the commit ran over
 * the old session, now over what the grant minted) plus the reap of
 * its run.
 */
export interface GrantedCandidateTarget {
  /** The committed candidate's exact pair. */
  readonly session: SessionRef;
  /** The candidate's project host scope — capability and route revocations' target. */
  readonly host: ProjectHostTarget;
  /** The candidate's origin lease. */
  readonly routes: RoutesTarget;
  /** The candidate's HTTP-side binding capability — `unbind`'s key. */
  readonly clientCapability: string;
  /** Reaps the granted run; the close report is the aftermath's evidence (complete or incomplete, sanitized, PID-free). */
  stopRun(): Promise<SupervisionCloseReport>;
}

/**
 * What a post-revocation failure's aftermath did (§4 step 7, the
 * revoked accounting): the candidate's authority revoked and its run
 * reaped WHERE APPLICABLE (a completion failure after a successful
 * grant), the launcher shown when a target remains, and the failed
 * no-active state reported.
 */
export interface FailureAftermath {
  /**
   * The granted candidate's ordered-revocation report — `null` when no
   * candidate was applicable; the boolean below derives from its outcome
   * (an incomplete pass never reads as revoked).
   */
  readonly candidateRevocation: RevocationReport | null;
  /** Derived from the candidate revocation's outcome — `complete` alone reads true. */
  readonly candidateRevoked: boolean;
  /** The granted run's reap close report; `null` when no candidate was applicable. */
  readonly candidateClose: SupervisionCloseReport | null;
  /** The launcher show was observed (only a target that remains is shown it). */
  readonly launcherObserved: boolean;
}

/**
 * The completion's answer: the observed outcome of the transition's
 * last step, or the irreversible failure with its aftermath — never a
 * renderer-side rejected promise with stale authority behind it (§9).
 */
export type CompletionResult =
  | {
      /** §4 step 6, activation: the exact main-frame ready handshake was observed. */
      readonly kind: 'activation-completed';
      readonly session: SessionRef;
      readonly target: CompletionClientIdentity;
    }
  | {
      /** §4 step 6, deactivation: launcher readiness was observed. */
      readonly kind: 'deactivation-completed';
      readonly session: SessionRef;
      readonly target: CompletionClientIdentity;
    }
  | {
      /**
       * §4 step 7, failure after revocation — irreversible: no active
       * session, the old one never resumed. `failure` is F6's fixed
       * `revocation`-category template when the input was F6's failed
       * grant, or the completion's own fixed template when a host
       * observation failed; `revoked` is the preserved old-side
       * accounting — the ordered pass's report for a switch, or the
       * first commit's honest nothing for a first activation (#349:
       * never a fabricated report shape); `aftermath` is what this
       * completion did about the candidate.
       */
      readonly kind: 'failed';
      readonly failure: SessionFailure;
      readonly target: CompletionClientIdentity;
      readonly revoked: RevocationAccounting;
      readonly aftermath: FailureAftermath;
    }
  | { readonly kind: 'rejected'; readonly reason: CompletionRejection };

/** The quit completion's answer: quit finishes either way — §8 lets an unobserved close still be an honest incomplete quit. */
// No `client` target reference here, by design: quit rides a deactivation
// whose completion already reported the frozen client identity, and a quit
// leaves no live client to name — the "every result carries the target"
// rule's one documented exception.
export type QuitResult =
  | {
      /** The target's close was observed — without navigation (the quit path never touched a ready seam). */
      readonly kind: 'quit-completed';
      readonly targetCloseObserved: boolean;
      readonly revoked: RevocationReport;
    }
  | { readonly kind: 'rejected'; readonly reason: CompletionRejection };

/** Why a completion refused — sanitized vocabulary only, nothing was driven. */
export type CompletionRejection =
  /** The transition input was F6's pre-linearization rejection: nothing was revoked, nothing to complete. */
  | 'transition-not-committed'
  /** Quit rides a settled deactivation — any other transition shape refuses. */
  | 'quit-requires-a-settled-deactivation';

/** The incomplete-reap aftermath's answer (§4 step 4's tail). */
export type IncompleteReapOutcome = {
  /** The blocked no-active state was entered: tombstone persisted, candidate rolled back, failure reported. */
  readonly kind: 'blocked-no-active';
  /** The fixed `incomplete-reap` failure the blocked state reports. */
  readonly failure: SessionFailure;
  readonly tombstonePersisted: true;
  /** The candidate rollback's close report; `null` when no candidate existed or its own machine had already settled it. */
  readonly rollback: SupervisionCloseReport | null;
};

/**
 * The fixed failure behind a host-observed completion failure — the E6
 * law, one template, no free text. Category `revocation` per the
 * protocol's own reading of the set ("a post-revocation commit failure
 * (irreversible)"): a completion failure IS one — the commit
 * linearized, the old authority is gone, and the observed completion
 * did not arrive.
 */
export const COMPLETION_FAILURE: SessionFailure = Object.freeze({
  category: 'revocation',
  message: 'the session completion failed after the outgoing authority was revoked',
});
