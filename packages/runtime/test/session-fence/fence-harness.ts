import type { WriteOutcome } from '../../edit-authority/executor/write-outcomes.ts';
import { sha256Hex } from '../../edit-authority/grants/canonical-bounds.ts';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import {
  shutdownFailure,
  WorkerRejectionError,
} from '../../project-plane/worker/worker-failure.ts';
import type { ProjectRun } from '../../project-runtime/project-runtime.ts';
import {
  ProjectRunBootError,
  type ProjectRunBootErrorCode,
} from '../../project-runtime/project-runtime.ts';
import type { DrainClock, QueuedEdit } from '../../session-supervisor/fence/edit-fence.ts';

/**
 * The #237 focused-test stand-ins, at the sanctioned level: a manual
 * drain clock (the deadline never fires unless the test fires it — the
 * five-second law is asserted against the armed delay, never by
 * waiting), a controllable queued edit per accepted operation (the
 * serialized-queue seam: execute-call order is recorded, outcomes
 * settle when the test says), and the slim fake ProjectRun the F4
 * composition leg needs (the E8 facade contract honored — the #236
 * harness idiom, pared to what the fence's transition-abort battery
 * observes). No real timers, no real children, no composition fakes.
 */

/** A controllable serialized-queue edit — the D5 executor dispatch stand-in. */
export interface ControlledEdit {
  readonly edit: QueuedEdit;
  /** Resolves the pending execute() with one terminal outcome. */
  settle(outcome: WriteOutcome): void;
  /** Rejects the pending execute() — the misbehaving-seam path. */
  fail(): void;
  /** How many times the queue called execute. */
  calls(): number;
}

/** One edit whose queue execution the test settles by hand. */
/** A valid committed outcome — the digest currency's shape, built like production builds it. */
export function committed(): WriteOutcome {
  return { type: 'committed', revision: sha256Hex(new TextEncoder().encode('landed')) };
}

export function controlledEdit(key: string): ControlledEdit {
  let calls = 0;
  let settleOutcome: (outcome: WriteOutcome) => void = () => {};
  let failExecute: (error: unknown) => void = () => {};
  const pending = new Promise<WriteOutcome>((resolve, reject) => {
    settleOutcome = resolve;
    failExecute = reject;
  });
  const edit: QueuedEdit = {
    key,
    execute: () => {
      calls += 1;
      return pending;
    },
  };
  return {
    edit,
    settle: (outcome) => {
      settleOutcome(outcome);
    },
    fail: () => {
      failExecute(new Error('queue seam defect'));
    },
    calls: () => calls,
  };
}

/** The manual drain clock — records the armed delay, fires only when the test fires it. */
export interface ManualClock {
  readonly clock: DrainClock;
  /** Every delay the machine armed, in order. */
  armedDelays(): readonly number[];
  /** Fires the one armed deadline (a no-op when disarmed or already fired). */
  fireDeadline(): void;
  /**
   * Fires the most recently armed deadline **even when disarmed** — the
   * sticky-timer simulation (a host timer already dequeued for execution
   * runs despite `clearTimeout`): the machine's verdict must stand.
   */
  firePastDisarm(): void;
  /** How many times a disarmer ran. */
  disarms(): number;
}

export function manualClock(): ManualClock {
  const delays: number[] = [];
  let disarms = 0;
  let armed: (() => void) | null = null;
  let lastArmed: (() => void) | null = null;
  const clock: DrainClock = {
    delay: (ms, fire) => {
      delays.push(ms);
      armed = fire;
      lastArmed = fire;
      return () => {
        disarms += 1;
        armed = null;
      };
    },
  };
  return {
    clock,
    armedDelays: () => delays,
    fireDeadline: () => {
      const fire = armed;
      armed = null;
      fire?.();
    },
    firePastDisarm: () => {
      lastArmed?.();
    },
    disarms: () => disarms,
  };
}

/**
 * The slim fake ProjectRun for the transition-abort composition (the
 * #236 staging-harness idiom, pared to this lane's observations):
 * readiness settles on command, stop is counted and never settles the
 * close report — closeWith owns that — and an unsettled readiness
 * rejects as 'cancelled' under stop.
 */
export interface SlimRun {
  readonly run: ProjectRun;
  settleReady(): void;
  closeWith(report: SupervisionCloseReport): void;
  readonly stopCalls: number;
}

/** A boring complete close report — tests override fields as needed. */
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

export function slimRun(): SlimRun {
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
      stopCalls += 1;
      if (!readySettled) {
        readySettled = true;
        rejectReady(new ProjectRunBootError('cancelled'));
      }
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
    closeWith: (report) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new ProjectRunBootError(
            (report.reason === 'startup-timeout'
              ? 'startup-timeout'
              : 'cancelled') satisfies ProjectRunBootErrorCode,
          ),
        );
      }
      settleOnce(report);
    },
    get stopCalls() {
      return stopCalls;
    },
  };
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

/** Two valid, distinct project keys (26 lowercase-base32 characters, the protocol's shape). */
export const PROJECT_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
export const PROJECT_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';

/** The total indexed read — a missing fixture item is a test bug, never a runtime state. */
export function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no fixture item at index ${index}`);
  return item;
}
