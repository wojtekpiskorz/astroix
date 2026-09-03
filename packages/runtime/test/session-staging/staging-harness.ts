import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import {
  shutdownFailure,
  WorkerRejectionError,
} from '../../project-plane/worker/worker-failure.ts';
import {
  type CertificationFacts,
  type ProjectRun,
  ProjectRunBootError,
  type ProjectRunBootErrorCode,
} from '../../project-runtime/project-runtime.ts';
import type {
  CandidateStartRequest,
  StartCandidateRun,
} from '../../session-supervisor/staging/session-supervisor.ts';

/**
 * The #236 focused-test stand-ins, at the sanctioned level: a fake
 * ProjectRun per candidate (the E8 facade contract honored — stop rejects
 * an unsettled readiness as 'cancelled', stop/closed settle the ONE
 * report) and a controllable startCandidate seam recording every launch
 * request. No composition fakes, no real children — the supervisor's
 * truth here is its own state machine over these seams.
 */

/** A complete, boring close report for the given reason — tests override fields as needed. */
export function completeReport(reason: SupervisionCloseReport['reason']): SupervisionCloseReport {
  return {
    reason,
    outcome: 'complete',
    failures: [],
    accounting: {
      workerReportReceived: true,
      workerCleanupComplete: true,
      workerReaped: true,
      managedAstroReaped: true,
      probesSettled: true,
      killEscalations: [],
    },
  };
}

export interface FakeRun {
  readonly run: ProjectRun;
  /** Resolves the run's readiness. */
  settleReady(): void;
  /** Rejects the run's readiness with the facade's sanitized boot error for the code. */
  failReady(code: Exclude<ProjectRunBootErrorCode, 'uncertified-pair'>): void;
  /**
   * Rejects the run's readiness with the facade's certification boot error
   * carrying the pair facts (#319 — the payload is required, not optional).
   */
  failReadyUncertifiedPair(facts: CertificationFacts): void;
  /** Rejects the run's readiness with exactly this error object — belt legs only. */
  failReadyError(error: unknown): void;
  /** Rejects the run's readiness with raw hostile text — the unknown-failure path. */
  failReadyRaw(message: string): void;
  /** Settles stop/closed with one report — caller stop or unsupervised crash. */
  closeWith(report: SupervisionCloseReport): void;
  /** How many times the run's stop was called. */
  readonly stopCalls: number;
}

const REPORT_BOOT_CODES: Partial<
  Record<SupervisionCloseReport['reason'], Exclude<ProjectRunBootErrorCode, 'uncertified-pair'>>
> = {
  'startup-timeout': 'startup-timeout',
  'worker-crash': 'worker-crash',
  'managed-astro-crash': 'managed-astro-crash',
};

/** The close-report reason a failed startup converges under, per boot code (the E8 law). */
const BOOT_REPORT_REASONS: Partial<
  Record<ProjectRunBootErrorCode, SupervisionCloseReport['reason']>
> = {
  'startup-timeout': 'startup-timeout',
  'worker-crash': 'worker-crash',
  'managed-astro-crash': 'managed-astro-crash',
};

export function fakeRun(): FakeRun {
  let stopCalls = 0;
  let readySettled = false;
  let closedSettled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {}); // anchored: the attempt surfaces it, the fake never hangs a test
  let settleClosed: (report: SupervisionCloseReport) => void = () => {};
  const closed = new Promise<SupervisionCloseReport>((resolve) => {
    settleClosed = resolve;
  });

  const rejectPendingReady = (error: Error): void => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(error);
  };
  const settleOnce = (report: SupervisionCloseReport): void => {
    if (closedSettled) return;
    closedSettled = true;
    settleClosed(report);
  };

  const run: ProjectRun = {
    ready,
    inspect: () => Promise.reject(new WorkerRejectionError(shutdownFailure())),
    subscribe: () => () => {},
    stop: () => {
      // The E8 plane-fake idiom: stop rejects an unsettled readiness as
      // 'cancelled' but never settles the report — the close report is
      // the run's own convergence, delivered by closeWith().
      stopCalls += 1;
      rejectPendingReady(new ProjectRunBootError('cancelled'));
      return closed;
    },
    closed,
  };

  return {
    run,
    settleReady: () => {
      readySettled = true;
      resolveReady();
    },
    failReady: (code) => {
      readySettled = true;
      rejectReady(new ProjectRunBootError(code));
      // a failed startup converges on its own (the E8 law): closed
      // settles without any stop
      settleOnce(completeReport(BOOT_REPORT_REASONS[code] ?? 'stopped'));
    },
    failReadyUncertifiedPair: (facts) => {
      readySettled = true;
      rejectReady(new ProjectRunBootError('uncertified-pair', facts));
      // The certification pre-flight fails before any child exists: the
      // launch-failure law converges on the never-spawned report shape
      // (a caller-stop reason, complete, nothing to clean).
      settleOnce(completeReport('cancelled'));
    },
    failReadyError: (error) => {
      readySettled = true;
      rejectReady(error as Error);
      settleOnce(completeReport('stopped'));
    },
    failReadyRaw: (message) => {
      readySettled = true;
      rejectReady(new Error(message));
      settleOnce(completeReport('stopped'));
    },
    closeWith: (report) => {
      // A close before any stop is the crash path: the run's own law
      // rejects an unsettled readiness under the report's reason.
      rejectPendingReady(new ProjectRunBootError(REPORT_BOOT_CODES[report.reason] ?? 'cancelled'));
      settleOnce(report);
    },
    get stopCalls() {
      return stopCalls;
    },
  };
}

export interface CandidateRuntimeControl {
  readonly startCandidate: StartCandidateRun;
  /** Every launch request, in order. */
  readonly requests: readonly CandidateStartRequest[];
  /** The runs handed back, in launch order. */
  readonly runs: readonly FakeRun[];
  /** When true, the next start throws (the composition-defect path). */
  failNextStart: boolean;
}

export function candidateRuntime(): CandidateRuntimeControl {
  const requests: CandidateStartRequest[] = [];
  const runs: FakeRun[] = [];
  const control: CandidateRuntimeControl = {
    startCandidate: (request) => {
      requests.push(request);
      if (control.failNextStart) {
        control.failNextStart = false;
        throw new Error(
          `cannot resolve astro at /Users/secret/root-${requests.length} (port 9999)`,
        );
      }
      const fake = fakeRun();
      runs.push(fake);
      return fake.run;
    },
    requests,
    runs,
    failNextStart: false,
  };
  return control;
}

/** One macrotask boundary — every chained microtask of a settled promise has run. */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 'pending' when the promise has not settled within the window — observation, never a timing assertion. */
export async function settlementOf(promise: Promise<unknown>, windowMs = 20): Promise<string> {
  return await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve('pending'), windowMs);
    }),
  ]);
}

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

/** Two valid, distinct project keys (26 lowercase-base32 characters, the protocol's shape). */
export const PROJECT_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
export const PROJECT_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
