import type { SessionFailure, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import { type ProjectRun, ProjectRunBootError } from '../../project-runtime/project-runtime.ts';

/**
 * The activation attempt (#236, F4; ADR-0006 §4 step 1 and §9
 * `ActivationAttempt`/`StagedCandidate`, CONTEXT.md "activation attempt"):
 * the staged transaction that may commit a candidate run or roll it back
 * while preserving the old session. One attempt owns exactly one candidate
 * {@link ProjectRun} started privately at `begin`; its `ready` promise
 * resolves with the {@link StagedCandidate} only after the candidate run's
 * own readiness settles — the old session stays authoritative through all
 * of it (the supervisor holds the authority table, not this machine).
 *
 * Terminal paths and who owns them: readiness failure, cancellation, and
 * rollback land here (F4); the drain and forced-transition reasons that
 * will later call `rollback` belong to F5 (#237); the receipt that will
 * gate `commit` belongs to F6 (#238) — `commit()` takes no receipt
 * parameter because staging cannot validate a proof it never minted; the
 * commit lane consumes its one-use receipt and then drives this
 * linearization (the declared-seam precedent of E8's proxy-health).
 *
 * Deterministic by construction: no timers, no IO — every deadline lives
 * in the run the supervisor injected (the plane's startup deadline, E7).
 */

/** Why an in-flight attempt was cancelled before its candidate readied. */
export type CancelReason = 'user' | 'shutdown';

/**
 * Why a readiness-completed candidate was rolled back before commit. The
 * drain reasons arrive from F5's fence (#237); `incomplete-reap` from F6's
 * force path (#238); `cancelled` is the host's own post-readiness cancel.
 */
export type RollbackReason = 'cancelled' | 'drain-conflict' | 'drain-timeout' | 'incomplete-reap';

/** How one attempt ended — `closed` settles exactly once with this. */
export type ActivationOutcome =
  | { readonly kind: 'committed'; readonly ref: SessionRef }
  | {
      readonly kind: 'failed';
      readonly failure: SessionFailure;
      readonly report: SupervisionCloseReport;
    }
  | {
      readonly kind: 'rolled-back';
      readonly reason: RollbackReason;
      readonly report: SupervisionCloseReport;
    }
  | { readonly kind: 'cancelled'; readonly report: SupervisionCloseReport };

/** The sanitized rejection `ready` settles with when the candidate fails to start. */
export class ActivationFailedError extends Error {
  constructor(readonly failure: SessionFailure) {
    super(failure.message);
    this.name = 'ActivationFailedError';
  }
}

/** Why `commit`, `rollback`, or `cancel` refused — structured, never free text. */
export type StageRejectionCode = 'not-ready' | 'settled' | 'committing' | 'not-current';

/** The structured rejection a staged-candidate method refuses with. */
export class StageRejectedError extends Error {
  constructor(readonly code: StageRejectionCode) {
    super(STAGE_REJECTION_MESSAGES[code]);
    this.name = 'StageRejectedError';
  }
}

const STAGE_REJECTION_MESSAGES: Record<StageRejectionCode, string> = {
  'not-ready': 'the candidate has not completed readiness',
  settled: 'the activation attempt has already ended',
  committing: 'the candidate is already committing',
  'not-current': 'the supervisor no longer holds this attempt as the live one',
};

/** What a successful commit returns: the reference that became active. */
export interface CommitResult {
  readonly committed: SessionRef;
}

/**
 * The readiness-completed candidate (ADR-0006 §9 `StagedCandidate`): still
 * private, still non-authoritative — the old session rules until
 * {@link StagedCandidate.commit} runs its synchronous linearization, and
 * {@link StagedCandidate.rollback} discards the candidate without ever
 * disturbing the old session.
 */
export interface StagedCandidate {
  readonly ref: SessionRef;
  /** Performs the commit linearization; rejects {@link StageRejectedError} when not stageable. */
  commit(): Promise<CommitResult>;
  /** Discards the readiness-completed candidate; the old session is untouched. */
  rollback(reason: RollbackReason): Promise<SupervisionCloseReport>;
}

/** The staged transaction handle (ADR-0006 §9 `ActivationAttempt`). */
export interface ActivationAttempt {
  readonly ref: SessionRef;
  /** Resolves with the staged candidate after private readiness; rejects {@link ActivationFailedError} on startup failure. */
  readonly ready: Promise<StagedCandidate>;
  /** Cancels the in-flight attempt (before commit); after readiness it is the rollback path. */
  cancel(reason: CancelReason): Promise<SupervisionCloseReport>;
  /** Settles exactly once, with the terminal outcome of the attempt. */
  readonly closed: Promise<ActivationOutcome>;
}

/** The supervisor callbacks the attempt drives — all synchronous state transitions. */
export interface AttemptHooks {
  /**
   * The commit linearization, called synchronously inside `commit()` after
   * the attempt's own guards passed: the supervisor swaps authority — the
   * one irreversible instant staging owns the state side of; F6 (#238)
   * owns the ordered external handoff around this call. Returns whether
   * THIS attempt was the live one and the swap ran; `false` is the loud
   * divergence signal (the attempt then refuses `not-current` instead of
   * reporting a success the supervisor never performed).
   */
  commitCandidate(ref: SessionRef): boolean;
  /**
   * The attempt ended without committing (startup failure, rollback, or
   * cancel): the supervisor updates its snapshot synchronously here;
   * `closed` settles asynchronously when the candidate run's one close
   * report arrives.
   */
  attemptEnded(
    end:
      | { readonly kind: 'failed'; readonly failure: SessionFailure }
      | { readonly kind: 'rolled-back'; readonly reason: RollbackReason }
      | { readonly kind: 'cancelled' },
  ): void;
}

/** The attempt's own lifecycle, observed through its public surface. */
type AttemptPhase = 'starting' | 'staged' | 'cancelling' | 'committing' | 'ended';

/** Maps a candidate-run readiness rejection to the sanitized session failure. */
function readinessFailureOf(error: unknown): SessionFailure {
  // Only the facade's sanitized boot error carries decision data; anything
  // else — including free text — is 'unknown' and its text never surfaces.
  if (error instanceof ProjectRunBootError) {
    const category: SessionFailure['category'] =
      error.code === 'startup-timeout'
        ? 'startup-timeout'
        : error.code === 'worker-crash' || error.code === 'managed-astro-crash'
          ? 'crash'
          : 'startup';
    return { category, message: FAILURE_MESSAGES[category] };
  }
  return { category: 'unknown', message: FAILURE_MESSAGES.unknown };
}

/** The fixed templates behind every session failure this machine records — the E6 law, no free text. */
export const FAILURE_MESSAGES: Readonly<Record<SessionFailure['category'], string>> = {
  startup: 'the candidate project session failed to start',
  'startup-timeout':
    'the candidate project session did not become ready within the startup deadline',
  certification: 'the managed project did not carry a certified Astro and Vite pair',
  'drain-conflict': 'the outgoing session reported a write conflict while draining',
  'drain-timeout': 'the outgoing session did not finish draining within its deadline',
  'incomplete-reap': 'a forced transition did not finish cleaning up the outgoing write executor',
  revocation: 'the outgoing session authority could not be revoked cleanly',
  crash: 'the active project session terminated unexpectedly',
  unknown: 'the session attempt failed for an unrecognized reason',
};

/** The failure category a rollback records on the snapshot, if any — a plain cancel is no failure. */
export function rollbackFailureCategory(reason: RollbackReason): SessionFailure['category'] | null {
  if (reason === 'cancelled') return null;
  return reason;
}

/**
 * Builds one activation attempt over an injected candidate run. The run is
 * the supervisor's to have started; this machine owns only the staged
 * transaction: private readiness, terminal convergence of the candidate,
 * and the commit/rollback guards.
 */
export function createActivationAttempt(input: {
  readonly ref: SessionRef;
  readonly run: ProjectRun;
  readonly hooks: AttemptHooks;
}): ActivationAttempt {
  const { ref, run, hooks } = input;

  let phase: AttemptPhase = 'starting';
  let closedSettled = false;
  let settleClosed: (outcome: ActivationOutcome) => void = () => {};
  const closed = new Promise<ActivationOutcome>((resolve) => {
    settleClosed = resolve;
  });

  /** `closed` settles exactly once, on the first terminal report to arrive. */
  const settleOutcome = (outcome: ActivationOutcome): void => {
    if (closedSettled) return;
    closedSettled = true;
    settleClosed(outcome);
  };

  /**
   * Stops the candidate run — the one idempotent stop — and settles
   * `closed` from its report. Convergence discipline (the E8 stop law,
   * held at every settlement site): a rejecting stop settles and answers
   * the never-spawned report instead of hanging `closed` or surfacing an
   * unhandled rejection. The real facade's stop converges by contract —
   * the catch is the belt for a misbehaving run, not a load-bearing
   * assumption.
   */
  const stopCandidate = (
    settle: (report: SupervisionCloseReport) => void,
  ): Promise<SupervisionCloseReport> =>
    run.stop().then(
      (report) => {
        settle(report);
        return report;
      },
      () => {
        const report = neverSpawnedReport();
        settle(report);
        return report;
      },
    );

  const candidate: StagedCandidate = {
    ref,
    commit: () => {
      if (phase === 'ended' || phase === 'committing') {
        return Promise.reject(new StageRejectedError('settled'));
      }
      if (phase !== 'staged') {
        return Promise.reject(new StageRejectedError('not-ready'));
      }
      phase = 'committing';
      // The one synchronous linearization: the supervisor swaps authority
      // inside this call. Its answer is the divergence guard — a refusal
      // must be loud (a structured `not-current` rejection, the attempt
      // spent), never a success the supervisor never performed.
      const linearized = hooks.commitCandidate(ref);
      phase = 'ended';
      if (!linearized) {
        // The orphaned candidate run is still stopped — nobody owns it
        // now — and `closed` converges on the never-spawned report: the
        // divergence is loud (the structured refusal below) and leaves
        // nothing hanging and nothing unhandled.
        void stopCandidate(() => {});
        settleOutcome({ kind: 'cancelled', report: neverSpawnedReport() });
        return Promise.reject(new StageRejectedError('not-current'));
      }
      const result: CommitResult = { committed: ref };
      settleOutcome({ kind: 'committed', ref });
      return Promise.resolve(result);
    },
    rollback: (reason) => {
      if (phase === 'committing') {
        return Promise.reject(new StageRejectedError('committing'));
      }
      if (phase !== 'staged') {
        return Promise.reject(new StageRejectedError('settled'));
      }
      phase = 'ended';
      hooks.attemptEnded({ kind: 'rolled-back', reason });
      return stopCandidate((report) => settleOutcome({ kind: 'rolled-back', reason, report }));
    },
  };

  const ready: Promise<StagedCandidate> = run.ready.then(
    () => {
      // Private readiness: the candidate is staged, never authoritative —
      // the supervisor's authority table does not move here.
      if (phase === 'starting') phase = 'staged';
      return candidate;
    },
    (error: unknown) => {
      if (phase === 'cancelling') throw error; // the cancel path owns this settlement
      phase = 'ended';
      const failure = readinessFailureOf(error);
      hooks.attemptEnded({ kind: 'failed', failure });
      // The run converges on its own failed startup (the E8 law); the
      // idempotent stop is the rollback discipline's belt-and-braces, and
      // the run's one report settles `closed`.
      void run
        .stop()
        .then((report) => settleOutcome({ kind: 'failed', failure, report }))
        .catch(() => settleOutcome({ kind: 'failed', failure, report: neverSpawnedReport() }));
      throw new ActivationFailedError(failure);
    },
  );
  // Anchored: the cancel path rethrows the run's rejection; consumers
  // observe `ready` on their own schedule, and no unread rejection may
  // surface as unhandled.
  ready.catch(() => {});

  const attempt: ActivationAttempt = {
    ref,
    ready,
    cancel: (_reason: CancelReason) => {
      // The reason vocabulary is the host's telemetry; one cancel path exists.
      if (phase === 'committing') {
        return Promise.reject(new StageRejectedError('committing'));
      }
      if (phase === 'staged') {
        // A post-readiness cancel IS the rollback path — the readiness-
        // completed candidate must be discarded, never abandoned.
        phase = 'ended';
        hooks.attemptEnded({ kind: 'rolled-back', reason: 'cancelled' });
        return stopCandidate((report) =>
          settleOutcome({ kind: 'rolled-back', reason: 'cancelled', report }),
        );
      }
      if (phase !== 'starting') {
        return Promise.reject(new StageRejectedError('settled'));
      }
      phase = 'cancelling';
      hooks.attemptEnded({ kind: 'cancelled' });
      return stopCandidate((report) => settleOutcome({ kind: 'cancelled', report }));
    },
    closed,
  };
  return attempt;
}

/**
 * The never-spawned close report — nothing existed, so nothing failed to
 * clean (the E8 never-spawned law). One helper for every convergence
 * site in this lane: a rejecting stop, a rejected close observation, a
 * disowned candidate, and a throwing launch seam all converge HERE
 * rather than each hand-rolling the literal.
 */
export function neverSpawnedReport(): SupervisionCloseReport {
  return {
    reason: 'cancelled',
    outcome: 'complete',
    failures: [],
    accounting: {
      workerReportReceived: false,
      workerCleanupComplete: true,
      workerReaped: true,
      managedAstroReaped: true,
      probesSettled: true,
      killEscalations: [],
    },
  };
}
