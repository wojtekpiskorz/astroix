import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalProjectRoot } from '../../astro-project-adapter/installed-pair.ts';
import { probeManagedDevServer } from '../managed-astro/dev-server.ts';
import {
  classifySupervisionClose,
  type SupervisionChild,
  type SupervisionCloseReport,
} from './close-report.ts';
import { type ExactChildPlan, minimalChildEnv } from './exact-child.ts';

/**
 * The plane supervisor (#231, ADR-0005 process topology + ADR-0006 §8):
 * the control plane's exact-child owner for one project plane. It spawns
 * the project-runtime worker and the managed Astro dev server as SIBLING
 * children — one spawn discipline, two retained handles, so a worker
 * crash cannot orphan the managed server behind an unknown PID —
 * supervises their readiness, and owns every terminal path:
 *
 * - **Readiness** — the worker answers one typed `project` inspection
 *   over its private wire (the serving loop is up) and the dev server
 *   answers `200` on its loopback origin (it is actually serving its
 *   real project). Both inside the startup deadline (ADR-0006 §8: 30 s),
 *   or the run is terminal.
 * - **Crash is terminal** — either child exiting before a caller stop
 *   terminates the run, revokes admission, and cleans the SIBLING
 *   without auto-restart: nothing here re-spawns, ever; a crashed plane
 *   stays dead by construction (the next run is a new supervisor).
 * - **Normal stop order** (the ticket's contract): the worker's IPC stop
 *   closes its runners, watchers, timers, and composition first; then
 *   the supervisor's own probe sockets settle; then BOTH exact children
 *   are terminated (SIGTERM, escalating to SIGKILL when ignored) and
 *   reaped under their bounds.
 * - **One recursive close report** — complete or incomplete, sanitized
 *   categories, never a PID: cleanup authority is these two live handles
 *   alone (no shell discovery, no PID lookup, no process groups — the
 *   pre-alpha plane needs none).
 *
 * This module is real process IO — every spawn, signal, socket, and
 * timer here runs against real children — so it sits on the CC-only
 * watchlist like the plane's other IO glue; the pure decision logic
 * lives in `exact-child.ts` and `close-report.ts` (covered tier) and the
 * lifecycle truth is the supervision process lane.
 */

/** Candidate startup deadline (ADR-0006 §8). */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
/** Bound on the worker's graceful close (report + exit) after its IPC stop (ADR-0006 §8 graceful stop). */
export const DEFAULT_STOP_TIMEOUT_MS = 5000;
/** SIGTERM→SIGKILL escalation grace per child (ADR-0006 §8 forced reap ladder). */
export const DEFAULT_TERM_GRACE_MS = 5000;
/** Bound on observing the exit after SIGKILL (ADR-0006 §8 forced reap). */
export const DEFAULT_KILL_REAP_MS = 2000;

/** The wire id of the supervisor's one readiness probe (E6's wire: integer ≥ 0). */
const WORKER_PROBE_ID = 0;

export type PlaneSupervisorState = 'starting' | 'running' | 'closing' | 'closed';
/**
 * The plane's admission (ADR-0006 §4's fencing, at plane level):
 * `pending` while starting, `admitted` once ready, and `revoked` —
 * terminally — from the instant any close path begins.
 */
export type PlaneAdmissionState = 'pending' | 'admitted' | 'revoked';

/** Why a supervised run failed to become ready — sanitized, never carrying paths or PIDs. */
export type SupervisionBootErrorCode = Exclude<SupervisionCloseReport['reason'], 'stopped'>;

const BOOT_MESSAGES: Record<SupervisionBootErrorCode, string> = {
  cancelled: 'the project plane was stopped before it became ready',
  'startup-timeout': 'the project plane did not become ready within the startup deadline',
  'worker-crash': 'the project-runtime worker child terminated before the run completed',
  'managed-astro-crash': 'the managed Astro dev server terminated before the run completed',
};

/** The sanitized terminal-startup rejection `ready` settles with. */
export class SupervisionBootError extends Error {
  constructor(readonly code: SupervisionBootErrorCode) {
    super(BOOT_MESSAGES[code]);
    this.name = 'SupervisionBootError';
  }
}

export interface PlaneSupervisorOptions {
  /** The worker child's exact spawn plan (IPC wire; E6's `worker-child.ts` tail in production). */
  readonly worker: ExactChildPlan;
  /** The managed Astro dev server's exact spawn plan (E-managed-astro's `managedDevServerPlan`). */
  readonly managedAstro: ExactChildPlan;
  /** The loopback port the dev-server plan told the managed server to serve on. */
  readonly devServerPort: number;
  /** The readiness probe path; defaults to `/`. */
  readonly readinessPath?: string;
  /** Startup deadline (ms); defaults to {@link DEFAULT_STARTUP_TIMEOUT_MS}. */
  readonly startupTimeoutMs?: number;
  /** Bound on the worker's graceful close (ms); defaults to {@link DEFAULT_STOP_TIMEOUT_MS}. */
  readonly stopTimeoutMs?: number;
  /** SIGTERM→SIGKILL grace per child (ms); defaults to {@link DEFAULT_TERM_GRACE_MS}. */
  readonly termGraceMs?: number;
  /** Bound on the post-SIGKILL exit (ms); defaults to {@link DEFAULT_KILL_REAP_MS}. */
  readonly killReapMs?: number;
  /** Dev-server readiness retry interval (ms). */
  readonly probeIntervalMs?: number;
}

export interface ProjectPlaneSupervisor {
  readonly state: PlaneSupervisorState;
  readonly admission: PlaneAdmissionState;
  /** Settles when both children are ready; rejects with a {@link SupervisionBootError} on every terminal startup outcome. */
  readonly ready: Promise<void>;
  /** Begins the terminal close; idempotent — every call settles with the one close report. */
  stop(): Promise<SupervisionCloseReport>;
  /** Settles with the close report after cleanup completes. */
  readonly closed: Promise<SupervisionCloseReport>;
}

/**
 * Spawns one exact child from its plan: executable plus argv (never a
 * shell string), canonical cwd, explicit environment, `shell: false` —
 * the whole transport decided by the plan, nothing discovered.
 */
export function spawnExactChild(plan: ExactChildPlan): ChildProcess {
  const argv = plan.ipc ? [...(plan.execArgv ?? []), ...plan.argv] : plan.argv;
  return spawn(plan.executable, argv, {
    cwd: plan.cwd,
    env: plan.env,
    shell: false,
    stdio: plan.ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
  });
}

/**
 * The production worker plan: forks E6's `worker-child.ts` tail (the
 * module resolves relative to this one — the packaged runtime rebases it
 * to the bundled entry per ADR-0008; a dev-checkout consumer that runs
 * raw Node supplies the bundler-resolution `execArgv`, the E6
 * process-lane disclosure) with the canonical root as the only
 * configuration it ever receives (argv, never a wire request). The
 * `nodeExecutable` override mirrors `managedDevServerPlan`'s, so both
 * siblings' spawn plans carry the same ADR-0008 shape — the packaged
 * runtime's bundled stock Node, one override for both children.
 */
export async function workerSpawnPlan(input: {
  readonly projectRoot: string;
  readonly execArgv?: readonly string[];
  /**
   * The Node executable for the child; defaults to the control plane's own
   * `process.execPath` (the bundled stock Node in the packaged runtime).
   */
  readonly nodeExecutable?: string;
}): Promise<ExactChildPlan> {
  const root = await canonicalProjectRoot(input.projectRoot);
  const workerModule = fileURLToPath(new URL('../worker/worker-child.ts', import.meta.url));
  return {
    executable: input.nodeExecutable ?? process.execPath,
    argv: [workerModule, JSON.stringify({ projectRoot: root })],
    cwd: root,
    env: minimalChildEnv(process.env),
    ipc: true,
    execArgv: input.execArgv ?? [],
  };
}

export function createProjectPlaneSupervisor(
  options: PlaneSupervisorOptions,
): ProjectPlaneSupervisor {
  const bounds = {
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    termGraceMs: options.termGraceMs ?? DEFAULT_TERM_GRACE_MS,
    killReapMs: options.killReapMs ?? DEFAULT_KILL_REAP_MS,
    probeIntervalMs: options.probeIntervalMs,
  };
  const workerChild = spawnExactChild(options.worker);
  const devServerChild = spawnExactChild(options.managedAstro);

  let currentState: PlaneSupervisorState = 'starting';
  let admissionState: PlaneAdmissionState = 'pending';
  let stopCall: Promise<SupervisionCloseReport> | null = null;
  let readySettled = false;
  let workerAnswered = false;
  let workerReport: { readonly outcome: string } | null = null;
  let workerGoneFlag = false;
  let devServerGoneFlag = false;

  let resolveReady: () => void = () => {};
  let rejectReady: (error: SupervisionBootError) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The terminal-startup rejection can fire from a child's exit event
  // before any caller reads `ready`; this anchor keeps an unread
  // rejection from surfacing as unhandled — the close report carries the
  // same fact for `closed`-only consumers.
  ready.catch(() => {
    // anchored, not swallowed: callers still observe the rejection
  });
  let resolveClosed: (report: SupervisionCloseReport) => void = () => {};
  const closed = new Promise<SupervisionCloseReport>((resolve) => {
    resolveClosed = resolve;
  });
  let resolveWorkerAnswer: () => void = () => {};
  const workerAnswer = new Promise<void>((resolve) => {
    resolveWorkerAnswer = resolve;
  });
  let resolveWorkerReported: () => void = () => {};
  const workerReported = new Promise<void>((resolve) => {
    resolveWorkerReported = resolve;
  });

  const probeAbort = new AbortController();
  const workerGone = goneOf(workerChild, () => {
    workerGoneFlag = true;
  });
  const devServerGone = goneOf(devServerChild, () => {
    devServerGoneFlag = true;
  });
  const devServerProbe = probeManagedDevServer({
    port: options.devServerPort,
    path: options.readinessPath,
    signal: probeAbort.signal,
    intervalMs: bounds.probeIntervalMs,
  });

  const startupTimer = setTimeout(() => initiateClose('startup-timeout'), bounds.startupTimeoutMs);

  const onWorkerMessage = (message: unknown): void => {
    const wire = message as {
      readonly type?: unknown;
      readonly id?: unknown;
      readonly ok?: unknown;
    } | null;
    if (wire?.type === 'inspect-result' && wire.id === WORKER_PROBE_ID) {
      // Readiness is a SUCCESSFUL project inspection (E6's `ok` flag): a
      // failed answer means the worker is alive but the composition it
      // would serve is dead — this plane never becomes ready, and the
      // startup deadline owns the terminal path.
      if (wire.ok === true) {
        workerAnswered = true;
        resolveWorkerAnswer();
      }
      return;
    }
    if (wire?.type === 'closed' && workerReport === null) {
      const reported = (message as { readonly report?: { readonly outcome?: unknown } }).report;
      // A report without a well-formed outcome fails closed as incomplete.
      workerReport = {
        outcome: typeof reported?.outcome === 'string' ? reported.outcome : 'incomplete',
      };
      resolveWorkerReported();
    }
  };

  const sendWorkerStop = (): void => {
    if (workerChild.connected === true && typeof workerChild.send === 'function') {
      workerChild.send({ type: 'stop' });
    }
  };

  workerChild.on('message', onWorkerMessage);
  workerChild.on('exit', () => onChildGone('worker'));
  workerChild.on('error', () => onChildGone('worker'));
  devServerChild.on('exit', () => onChildGone('managed-astro'));
  devServerChild.on('error', () => onChildGone('managed-astro'));
  if (workerChild.connected === true && typeof workerChild.send === 'function') {
    workerChild.send({
      type: 'inspect',
      id: WORKER_PROBE_ID,
      request: { kind: 'project' },
    });
  }

  void (async () => {
    const [, served] = await Promise.all([workerAnswer, devServerProbe]);
    if (served !== 'ready' || currentState !== 'starting') return; // a close owns the outcome
    clearTimeout(startupTimer);
    currentState = 'running';
    admissionState = 'admitted';
    readySettled = true;
    resolveReady();
  })();

  function onChildGone(child: 'worker' | 'managed-astro'): void {
    if (currentState !== 'starting' && currentState !== 'running') return;
    initiateClose(child === 'worker' ? 'worker-crash' : 'managed-astro-crash');
  }

  function initiateClose(reason: SupervisionCloseReport['reason']): void {
    if (currentState === 'closing' || currentState === 'closed') return;
    currentState = 'closing';
    admissionState = 'revoked';
    clearTimeout(startupTimer);
    probeAbort.abort(); // the supervisor's probe sockets close first, before any child is signalled
    if (!readySettled) {
      readySettled = true;
      // A stop that lands before readiness is a cancellation by definition —
      // the run never became ready (unreachable from `stop()` today, which
      // only answers 'stopped' once running, but honest if that ever drifts).
      rejectReady(new SupervisionBootError(reason === 'stopped' ? 'cancelled' : reason));
    }
    stopCall ??= runClose(reason);
  }

  async function runClose(
    reason: SupervisionCloseReport['reason'],
  ): Promise<SupervisionCloseReport> {
    const gracefulExited = await gracefulWorkerClose(reason);
    const probesSettled = await settleProbes();
    const [workerTermination, devServerTermination] = await Promise.all([
      terminateAndReap({
        child: workerChild,
        gone: workerGone,
        isGone: () => workerGoneFlag,
        termGraceMs: bounds.termGraceMs,
        killReapMs: bounds.killReapMs,
      }),
      terminateAndReap({
        child: devServerChild,
        gone: devServerGone,
        isGone: () => devServerGoneFlag,
        termGraceMs: bounds.termGraceMs,
        killReapMs: bounds.killReapMs,
      }),
    ]);
    workerChild.removeListener('message', onWorkerMessage);
    const killEscalations: SupervisionChild[] = [];
    if (workerTermination.escalated) killEscalations.push('worker');
    if (devServerTermination.escalated) killEscalations.push('managed-astro');
    const report = classifySupervisionClose({
      reason,
      workerReportExpected: reason !== 'worker-crash' && workerAnswered,
      workerReportReceived: workerReport !== null,
      workerCleanupComplete: workerReport === null || workerReport.outcome === 'complete',
      workerReaped: gracefulExited || workerTermination.reaped,
      managedAstroReaped: devServerTermination.reaped,
      probesSettled,
      killEscalations,
    });
    currentState = 'closed';
    resolveClosed(report);
    return report;
  }

  /** The worker's graceful close: IPC stop, then its close report AND exit, both inside the stop bound. */
  async function gracefulWorkerClose(reason: SupervisionCloseReport['reason']): Promise<boolean> {
    if (reason === 'worker-crash') return true; // already gone — nothing to ask
    sendWorkerStop();
    return raceBound(Promise.all([workerReported, workerGone]), bounds.stopTimeoutMs);
  }

  /** The sockets step: every aborted readiness probe settles within the stop bound. */
  async function settleProbes(): Promise<boolean> {
    const workerAnswerOrAbort = Promise.race([workerAnswer, abortRejected(probeAbort.signal)]);
    return raceBound(
      Promise.allSettled([workerAnswerOrAbort, devServerProbe]),
      bounds.stopTimeoutMs,
    );
  }

  return {
    get state(): PlaneSupervisorState {
      return currentState;
    },
    get admission(): PlaneAdmissionState {
      return admissionState;
    },
    ready,
    stop: () => {
      initiateClose(currentState === 'running' ? 'stopped' : 'cancelled');
      return stopCall as Promise<SupervisionCloseReport>;
    },
    closed,
  };
}

/** Resolves once when the child is gone (exit or spawn error) — the reap signal. */
function goneOf(child: ChildProcess, onGone: () => void): Promise<void> {
  return new Promise((resolve) => {
    const once = (): void => {
      onGone();
      resolve();
    };
    child.once('exit', once);
    child.once('error', once);
    if (child.exitCode !== null || child.signalCode !== null) once();
  });
}

/** Terminates and reaps one exact child: TERM, then KILL when ignored, bounded at every rung. */
async function terminateAndReap(input: {
  readonly child: ChildProcess;
  readonly gone: Promise<void>;
  readonly isGone: () => boolean;
  readonly termGraceMs: number;
  readonly killReapMs: number;
}): Promise<{ readonly reaped: boolean; readonly escalated: boolean }> {
  if (input.isGone()) return { reaped: true, escalated: false };
  input.child.kill('SIGTERM');
  if (await raceBound(input.gone, input.termGraceMs)) return { reaped: true, escalated: false };
  input.child.kill('SIGKILL');
  const reaped = await raceBound(input.gone, input.killReapMs);
  return { reaped, escalated: true };
}

/** True when `work` settles before `ms` — the timer dies with the race either way (no dangling bounds). */
function raceBound(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const settled = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(settled, settled);
  });
}

/** Rejects with the signal's reason when it fires — immediately when it already has (an already-aborted signal never emits its event again: the abort leg must not hang a close on a pre-aborted signal). */
function abortRejected(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
