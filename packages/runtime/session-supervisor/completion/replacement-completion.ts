import type { ProjectKey, SessionFailure } from '@wojciechpiskorz/astroix-protocol';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import type { CommittedTransition } from '../commit/switch-coordinator.ts';
import {
  type RevocationReport,
  type RevocationSurfaces,
  revokeOldAuthority,
} from '../revocation/authority-revocation.ts';
import { FAILURE_MESSAGES, neverSpawnedReport } from '../staging/activation-attempt.ts';
import type { StagedCandidate } from '../staging/session-supervisor.ts';
import type { BootTombstone } from '../tombstone/boot-tombstone.ts';
import {
  COMPLETION_FAILURE,
  type CompletionClientIdentity,
  type CompletionResult,
  type FailureAftermath,
  type GrantedCandidateTarget,
  type HostCompletionObservations,
  type IncompleteReapOutcome,
  type QuitResult,
} from './completion-result.ts';

// The seam entry's own contract (the #305 re-export idiom): a consumer of
// `session-supervisor/completion` names the whole public vocabulary — the
// observed-completion contract, the result unions, the aftermath, and the
// fixed completion-failure template — without reaching around the exports
// map.
export type {
  CompletionClientIdentity,
  CompletionRejection,
  CompletionResult,
  FailureAftermath,
  GrantedCandidateTarget,
  HostCompletionObservations,
  IncompleteReapOutcome,
  QuitResult,
} from './completion-result.ts';
export { COMPLETION_FAILURE } from './completion-result.ts';

/**
 * The replacement completion (#239, F7; ADR-0006 §4 steps 6–7 and §9's
 * `completeReplacement` sentence): the transition's LAST step — the
 * host-observed completion of a settled {@link CommittedTransition},
 * and the irreversible aftermath when authority was already revoked
 * and something failed anyway.
 *
 * The laws this machine holds:
 *
 * - **Completion is host-observed** (§4 step 6): activation awaits the
 *   EXACT main-frame ready handshake (the host has reset the client and
 *   replaced the top level; the observation is the exact frame's),
 *   deactivation awaits launcher readiness, and quit closes the target
 *   WITHOUT navigation — the quit path drives only the close
 *   observation and structurally never touches a ready seam, so no
 *   navigation event can be load-bearing for it. The seams are the
 *   observed-promise contract the Electron host lanes satisfy (the E8
 *   declared-seam precedent); nothing here drives a renderer itself.
 * - **Failure after revocation is irreversible** (§4 step 7): a
 *   completion failure — or F6's own `failed` grant result arriving as
 *   input — runs the aftermath IN THE ADR'S ORDER: revoke and reap the
 *   candidate WHERE APPLICABLE (only a granted candidate has authority
 *   to revoke — authority first, child reaped after, ADR-0005's stop
 *   order held by the reused ordered pass), show the launcher when a
 *   target remains, then report the failed no-active state. The old
 *   session is NEVER resumed: this machine owns no resume operation at
 *   all — no fence resume, no re-mint, no re-bind — and its failure
 *   results carry the old side's revoked accounting unchanged.
 * - **The receipt's client identity is consumed here** (the #239 carried
 *   input): the document + supervisor-side capability the receipt froze
 *   at issuance are this completion's target reference — every result
 *   reports them (nothing re-validates authority off a receipt; the
 *   mint validated it).
 * - **The incomplete-reap tail** (§4 step 4): `handleIncompleteReap`
 *   runs what follows F6's `incomplete-reap` preparation outcome in the
 *   ADR's order — atomically persist the boot-scoped tombstone FIRST
 *   (a crash mid-aftermath leaves it standing), grant nothing, roll
 *   back the candidate under F4's `incomplete-reap` reason, and enter
 *   the blocked no-active state through the failure report.
 * - **Convergence discipline** (the E8 stop law, held at every seam): a
 *   rejecting candidate reap settles on the never-spawned report, a
 *   rejecting rollback records `null` (the candidate's own machine had
 *   already settled it — its convergence is its own), and an
 *   unobserved launcher show is the honest `false`, never a hang and
 *   never an unhandled rejection.
 *
 * Deterministic by construction: no timers, no sockets — every
 * observation, surface, and the tombstone recorder are injected seams
 * (the real tables arrive as the F6 composition's singletons; the
 * observations and the lease probe are the declared host seams).
 */
export interface ReplacementCompletionInput {
  /** F6's settled outcome — the linearized transition this completion observes. */
  readonly commit: CommittedTransition;
  /** The host observation seams for THIS completion (one per target). */
  readonly observations: HostCompletionObservations;
  /** The receipt's frozen client identity — reported in the result. */
  readonly client: CompletionClientIdentity;
  /** The granted candidate's revocation targets and reap — the aftermath's "where applicable". */
  readonly candidate?: GrantedCandidateTarget;
  /** Whether a browser target remains — the failure path shows the launcher only then (§4 step 7). */
  readonly targetRemains: boolean;
}

/** The quit completion's input: quit rides a settled deactivation and observes the target's close. */
export interface QuitCompletionInput {
  readonly commit: CommittedTransition;
  readonly observations: HostCompletionObservations;
}

/** The incomplete-reap aftermath's input (§4 step 4's tail). */
export interface IncompleteReapInput {
  readonly projectKey: ProjectKey;
  /** Recorded diagnostic evidence ONLY — the tombstone persists it and never reads it (§8). */
  readonly recordedPid: number | null;
  /** The supervisor's reap accounting as observed when the aftermath began; `null` when none had arrived. */
  readonly closeReport: SupervisionCloseReport | null;
  /** The staged candidate to roll back under F4's `incomplete-reap` reason; `null` for a deactivation's force path. */
  readonly candidate: StagedCandidate | null;
}

/** Construction options — the shared revocation surfaces, the state report, and the tombstone recorder. */
export interface SessionCompletionOptions extends RevocationSurfaces {
  /**
   * Records the failed no-active state on the supervisor snapshot (§4
   * step 7 "report `failed` with no active session"). The declared
   * seam: the F4 supervisor's own failure-report surface arrives with
   * the integration lane; the focused tests observe this hook.
   */
  readonly reportFailedNoActive: (failure: SessionFailure) => void;
  /** The boot-scoped tombstone machine — the incomplete-reap tail's durable half. */
  readonly tombstones: Pick<BootTombstone, 'recordIncompleteReap'>;
}

/** The completion driver's surface. */
export interface SessionCompletion {
  /** Observes the settled transition's completion (§4 step 6) and owns its failure aftermath (§4 step 7). */
  completeReplacement(input: ReplacementCompletionInput): Promise<CompletionResult>;
  /** Quit: closes the target without navigation — the close observation alone, never a ready seam. */
  completeQuit(input: QuitCompletionInput): Promise<QuitResult>;
  /** The incomplete forced reap's aftermath (§4 step 4's tail): tombstone first, then rollback, then the blocked state. */
  handleIncompleteReap(input: IncompleteReapInput): Promise<IncompleteReapOutcome>;
}

/** The fixed failure behind the blocked no-active state — staging's one `incomplete-reap` template, no free text. */
const INCOMPLETE_REAP_FAILURE: SessionFailure = Object.freeze({
  category: 'incomplete-reap',
  message: FAILURE_MESSAGES['incomplete-reap'],
});

/** One observation's honest verdict: resolved = observed, rejected = the host observed failure. */
async function observedOutcome(observe: () => Promise<void>): Promise<boolean> {
  try {
    await observe();
    return true;
  } catch {
    return false;
  }
}

/** Reaps the granted run — a rejecting stop settles on the never-spawned report (the E8 stop law's belt). */
async function reapRun(candidate: GrantedCandidateTarget): Promise<SupervisionCloseReport> {
  return await candidate.stopRun().then(
    (report) => report,
    () => neverSpawnedReport(),
  );
}

/** Builds the completion driver over the injected seams. */
export function createSessionCompletion(options: SessionCompletionOptions): SessionCompletion {
  /**
   * The §4 step 7 aftermath, in the ADR's order: revoke and reap the
   * candidate where applicable, show the launcher when a target
   * remains, report the failed no-active state. The candidate
   * revocation is F6's own ordered pass, read-only reuse, over the
   * granted candidate's targets — authority dies before its run's
   * children are reaped (the ADR-0005 stop order the pass holds).
   */
  const runFailureAftermath = async (
    input: ReplacementCompletionInput,
    failure: SessionFailure,
    candidateGranted: boolean,
  ): Promise<FailureAftermath> => {
    let candidateRevoked = false;
    let candidateClose: SupervisionCloseReport | null = null;
    const candidate = input.candidate ?? null;
    if (candidateGranted && candidate !== null) {
      await revokeOldAuthority({
        session: candidate.session,
        host: candidate.host,
        clientCapability: candidate.clientCapability,
        routes: candidate.routes,
        surfaces: options,
      });
      candidateRevoked = true;
      candidateClose = await reapRun(candidate);
    }
    const launcherObserved = input.targetRemains
      ? await observedOutcome(input.observations.launcherReady)
      : false;
    options.reportFailedNoActive(failure);
    return { candidateRevoked, candidateClose, launcherObserved };
  };

  /** The failed result's shared tail — the aftermath plus the preserved revoked accounting. */
  const failedResult = async (
    input: ReplacementCompletionInput,
    failure: SessionFailure,
    revoked: RevocationReport,
    candidateGranted: boolean,
  ): Promise<CompletionResult> => {
    const aftermath = await runFailureAftermath(input, failure, candidateGranted);
    return { kind: 'failed', failure, target: input.client, revoked, aftermath };
  };

  return {
    completeReplacement: async (input) => {
      const { commit } = input;
      if (commit.kind === 'rejected') {
        // F6's pre-linearization rejection: nothing was revoked, nothing
        // was granted — there is no completion to observe.
        return { kind: 'rejected', reason: 'transition-not-committed' };
      }
      if (commit.kind === 'failed') {
        // F6's irreversible failed grant — the fixed revocation-category
        // template and revoked accounting are the input; the candidate
        // was never granted, so no candidate authority exists to revoke.
        return await failedResult(input, commit.failure, commit.revoked, false);
      }
      if (commit.kind === 'committed') {
        // §4 step 6, activation: the exact main-frame ready handshake.
        if (await observedOutcome(input.observations.mainFrameReady)) {
          return { kind: 'activation-completed', session: commit.committed, target: input.client };
        }
        return await failedResult(input, COMPLETION_FAILURE, commit.revoked, true);
      }
      // §4 step 6, deactivation: launcher readiness.
      if (await observedOutcome(input.observations.launcherReady)) {
        return {
          kind: 'deactivation-completed',
          session: commit.deactivated,
          target: input.client,
        };
      }
      return await failedResult(input, COMPLETION_FAILURE, commit.revoked, false);
    },

    completeQuit: async (input) => {
      if (input.commit.kind !== 'deactivated') {
        return { kind: 'rejected', reason: 'quit-requires-a-settled-deactivation' };
      }
      // "Quit closes the target without navigating": the close
      // observation is the ONLY seam this path drives — no ready
      // handshake exists on it, so no navigation event can be
      // load-bearing for the quit. §8: quit may still finish with the
      // honest unobserved-close marker — nothing is left to revoke.
      const closed = await observedOutcome(input.observations.targetClosed);
      return { kind: 'quit-completed', targetCloseObserved: closed, revoked: input.commit.revoked };
    },

    handleIncompleteReap: async (input) => {
      // §4 step 4's tail, in the ADR's order: the tombstone stands
      // durably BEFORE anything else runs — a crash in the rest of the
      // aftermath leaves it standing — and NO authority is granted
      // anywhere in this path (there is no receipt, so there is no
      // grant; the machine structurally owns none).
      await options.tombstones.recordIncompleteReap({
        projectKey: input.projectKey,
        recordedPid: input.recordedPid,
        closeReport: input.closeReport,
      });
      let rollback: SupervisionCloseReport | null = null;
      if (input.candidate !== null) {
        rollback = await input.candidate.rollback('incomplete-reap').then(
          (report) => report,
          () => {
            // The rollback refused: the candidate's own machine had
            // already settled it, and its convergence is its own — the
            // blocked state reports regardless.
            return null;
          },
        );
      }
      options.reportFailedNoActive(INCOMPLETE_REAP_FAILURE);
      return {
        kind: 'blocked-no-active',
        failure: INCOMPLETE_REAP_FAILURE,
        tombstonePersisted: true,
        rollback,
      };
    },
  };
}
