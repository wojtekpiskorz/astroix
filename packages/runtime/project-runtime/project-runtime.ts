import type { SupervisionCloseReport } from '../project-plane/supervision/close-report.ts';
import type {
  ProjectPlaneSupervisor,
  SupervisionBootErrorCode,
} from '../project-plane/supervision/plane-supervisor.ts';
import type { WorkerEvent } from '../project-plane/worker/worker-events.ts';
import {
  malformedRequestFailure,
  shutdownFailure,
  WorkerRejectionError,
} from '../project-plane/worker/worker-failure.ts';
import {
  isWorkerInspectionRequest,
  type WorkerInspectionRequest,
  type WorkerInspectionResult,
} from '../project-plane/worker/worker-request.ts';
import { launchManagedPlane } from './plane-launch.ts';
import { type ProxyHealthPrerequisite, satisfiedProxyHealth } from './proxy-health.ts';

// The facade entry's own contract (the #305 re-export idiom): a consumer
// of `project-runtime` must be able to name the whole public vocabulary —
// the typed inspection requests/results, the events, the close report,
// and the rejection species a `ready`/`inspect` catch handles — without
// reaching around the exports map.
export type { SupervisionCloseReport } from '../project-plane/supervision/close-report.ts';
export type { WorkerEvent } from '../project-plane/worker/worker-events.ts';
export { WorkerRejectionError } from '../project-plane/worker/worker-failure.ts';
export type {
  WorkerInspectionRequest,
  WorkerInspectionResult,
} from '../project-plane/worker/worker-request.ts';
export type { LaunchManagedPlaneInput } from './plane-launch.ts';
export { type ProxyHealthPrerequisite, satisfiedProxyHealth } from './proxy-health.ts';

/**
 * The deep, process-neutral project runtime (#232, ADR-0005
 * `ProjectRuntime`; CONTEXT.md "ProjectRuntime"): `start()` hands back a
 * {@link ProjectRun} IMMEDIATELY — startup can be observed and stopped —
 * and the run's members compose the landed plane stack behind one
 * redacted surface:
 *
 * - **`ready`** resolves only after the plane's prerequisites (pair
 *   certification through the supervisor's ok-gated probe, both exact
 *   children, the composition pipeline, and the managed dev server's
 *   loopback route) AND the proxy-health prerequisite — the declared,
 *   deferred seam F1 (#233) wires. Every terminal startup outcome
 *   (launch failure, supervisor boot failure, failed health check,
 *   stop-during-startup) rejects with one sanitized
 *   {@link ProjectRunBootError}.
 * - **`inspect`** accepts ONLY the four typed request families (E6's
 *   guard re-applied at this boundary — defense in depth, never the
 *   sole gate) and settles with the revisioned typed results THE
 *   supervised worker produced, dispatched over the supervisor's
 *   worker-wire facet (correlated ids ≥ 1; divergent revisions from any
 *   other worker would break the revision contract).
 * - **`subscribe`** forwards the worker's public events — revisioned
 *   invalidations and structured diagnostics — nothing else exists on
 *   the stream.
 * - **`stop`/`closed`** converge to the SAME `SupervisionCloseReport`:
 *   the supervisor's one recursive report for every stop, crash, and
 *   startup-failure path (a launch that never produced a plane mints
 *   the never-spawned report — nothing to clean, explicitly complete).
 *   `stop` is idempotent and settles the same instance every call.
 *
 * Nothing disposable crosses the surface: no PID, port, raw project
 * path, Vite handle, runner, watcher, timer, or child-process object —
 * the supervisor, its wire, and both children stay behind this facade
 * (the redaction tests sweep every public result, event, report, and
 * error for disclosure shapes and forbidden keys).
 *
 * This module is the pure sequencing/redaction layer over the injected
 * launch and health seams (covered tier; the focused tests fake exactly
 * those seams). The production launch composition lives in
 * `plane-launch.ts` — real process IO, watchlist tier, like the plane's
 * other IO glue.
 */

/** Why a run failed to become ready — sanitized codes only (ADR-0006 §7 output hygiene). */
export type ProjectRunBootErrorCode = SupervisionBootErrorCode | 'proxy-health' | 'launch-failed';

/** The fixed templates behind every boot-rejection message — no free text ever enters (the E6 law). */
const BOOT_MESSAGES: Record<ProjectRunBootErrorCode, string> = {
  cancelled: 'the project plane was stopped before it became ready',
  'startup-timeout': 'the project plane did not become ready within the startup deadline',
  'worker-crash': 'the project-runtime worker child terminated before the run completed',
  'managed-astro-crash': 'the managed Astro dev server terminated before the run completed',
  'proxy-health': 'the proxy health prerequisite failed during project startup',
  'launch-failed': 'the project plane could not be launched for the requested project',
};

/** The supervisor's own boot codes — everything `plane.ready` can reject with (E7's closed set). */
const SUPERVISOR_BOOT_CODES: readonly SupervisionBootErrorCode[] = [
  'cancelled',
  'startup-timeout',
  'worker-crash',
  'managed-astro-crash',
];

/** The sanitized terminal-startup rejection `ready` settles with — the facade's one boot-error shape. */
export class ProjectRunBootError extends Error {
  constructor(readonly code: ProjectRunBootErrorCode) {
    super(BOOT_MESSAGES[code]);
    this.name = 'ProjectRunBootError';
  }
}

/** Maps a plane-readiness rejection to the facade's boot error: the supervisor's code through, anything else launch-shaped. */
function toBootError(error: unknown): ProjectRunBootError {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (
    typeof code === 'string' &&
    SUPERVISOR_BOOT_CODES.includes(code as SupervisionBootErrorCode)
  ) {
    return new ProjectRunBootError(code as SupervisionBootErrorCode);
  }
  return new ProjectRunBootError('launch-failed');
}

/** One start's identity (ADR-0005 `StartProject`): the managed project's root plus the dev server's loopback port. */
export interface StartProjectInput {
  /** The managed project root; canonicalized inside the launch (never surfaced back). */
  readonly projectRoot: string;
  /**
   * The loopback port the managed dev server is told to serve on —
   * caller-owned configuration (the control plane's port discipline,
   * ADR-0005), an INPUT only: no public result, event, or report ever
   * carries it.
   */
  readonly devServerPort: number;
}

/** Launches one supervised managed plane; defaults to the production composition (`plane-launch.ts`). */
export type LaunchPlane = (input: StartProjectInput) => Promise<ProjectPlaneSupervisor>;

export interface ProjectRuntimeOptions {
  /** The plane launcher; defaults to {@link launchManagedPlane} (real children, watchlist tier). */
  readonly launchPlane?: LaunchPlane;
  /**
   * The proxy-health readiness prerequisite; defaults to the
   * declared-but-satisfied seam (the documented F1 #233 deferral).
   */
  readonly proxyHealth?: ProxyHealthPrerequisite;
}

/** The process-neutral run handle (ADR-0005 `ProjectRun`) — exactly five members, nothing else. */
export interface ProjectRun {
  /** Resolves after every readiness prerequisite; rejects with {@link ProjectRunBootError} on every terminal startup outcome. */
  readonly ready: Promise<void>;
  /**
   * Dispatches one typed inspection to THE supervised worker; settles with
   * its revisioned typed result. Lawful before `ready` settles: work
   * dispatched mid-start queues on the launch and settles (or rejects with
   * the structured shutdown failure) once the plane arrives — readiness
   * gates observation, not dispatch.
   */
  inspect(request: WorkerInspectionRequest): Promise<WorkerInspectionResult>;
  /** Subscribes to the run's public events (revisioned invalidations, structured diagnostics); the return unbinds. */
  subscribe(listener: (event: WorkerEvent) => void): () => void;
  /** Begins the terminal close; idempotent — every call settles the one close report. */
  stop(): Promise<SupervisionCloseReport>;
  /** Settles with the same close report after cleanup completes, on every terminal path. */
  readonly closed: Promise<SupervisionCloseReport>;
}

/** The deep seam itself (ADR-0005): one factory, one disposable run per start. */
export interface ProjectRuntime {
  start(input: StartProjectInput): ProjectRun;
}

/** Builds one runtime over injectable launch/health seams — the focused tests' boundary. */
export function createProjectRuntime(options: ProjectRuntimeOptions = {}): ProjectRuntime {
  const launchPlane: LaunchPlane = options.launchPlane ?? launchManagedPlane;
  const proxyHealth = options.proxyHealth ?? satisfiedProxyHealth;
  return {
    start: (input) => startRun(input, launchPlane, proxyHealth),
  };
}

/** The never-spawned report a failed launch converges to — nothing existed, so nothing failed to clean. */
function neverSpawnedReport(): SupervisionCloseReport {
  return {
    reason: 'cancelled',
    outcome: 'complete',
    failures: [],
    accounting: {
      workerReportReceived: false,
      // The classifier's own semantics: true when no report was ever expected.
      workerCleanupComplete: true,
      workerReaped: true,
      managedAstroReaped: true,
      probesSettled: true,
      killEscalations: [],
    },
  };
}

function startRun(
  input: StartProjectInput,
  launchPlane: LaunchPlane,
  proxyHealth: ProxyHealthPrerequisite,
): ProjectRun {
  let stopped = false;
  let stopCall: Promise<SupervisionCloseReport> | null = null;
  let failedReport: SupervisionCloseReport | null = null;
  const healthAbort = new AbortController();

  // The launch is async (canonical root, the project's own astro CLI) but
  // the HANDLE is sync by contract: every plane-dependent member composes
  // this promise instead of awaiting it at start time.
  const launch = Promise.resolve().then(() => launchPlane(input));
  // Anchored, not swallowed: `ready`/`closed`/`stop` surface the failure;
  // the anchor keeps an unread rejection from surfacing as unhandled.
  launch.catch(() => {});

  const ready = launch.then(
    (plane) =>
      plane.ready.then(
        () => healthPhase(plane),
        (error) => {
          throw toBootError(error);
        },
      ),
    () => {
      throw new ProjectRunBootError('launch-failed');
    },
  );
  // The same anchor for the facade's own rejection paths.
  ready.catch(() => {});

  const closed: Promise<SupervisionCloseReport> = (async () => {
    try {
      return await (await launch).closed;
    } catch {
      failedReport ??= neverSpawnedReport();
      return failedReport;
    }
  })();

  const listeners = new Set<(event: WorkerEvent) => void>();
  // One forwarding subscription attaches when the plane arrives and dies
  // with its wire; consumers bind and unbind against the local set — a
  // subscriber registered before the launch resolves still receives
  // everything the plane ever publishes.
  void launch.then(
    (plane) => {
      plane.workerWire.subscribe((event) => {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {
            // a subscriber bug must not break the run's event chain (the E6 law)
          }
        }
      });
    },
    () => {},
  );

  async function healthPhase(plane: ProjectPlaneSupervisor): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new ProjectRunBootError('cancelled'));
      if (healthAbort.signal.aborted) {
        onAbort();
        return;
      }
      healthAbort.signal.addEventListener('abort', onAbort, { once: true });
      const done = (): void => healthAbort.signal.removeEventListener('abort', onAbort);
      proxyHealth.check({ signal: healthAbort.signal }).then(
        () => {
          done();
          resolve();
        },
        () => {
          done();
          // The check's own text is untrusted free text — never surfaced.
          reject(new ProjectRunBootError('proxy-health'));
          if (!healthAbort.signal.aborted) {
            // Terminal convergence: a failed prerequisite stops the plane;
            // the one report settles through `stop`/`closed`.
            void plane.stop();
          }
        },
      );
    });
  }

  return {
    ready,
    inspect: (request) => {
      // The sync guard first: after any stop began, new work rejects
      // immediately, structured, without awaiting the launch.
      if (stopped) return Promise.reject(new WorkerRejectionError(shutdownFailure()));
      if (!isWorkerInspectionRequest(request)) {
        return Promise.reject(new WorkerRejectionError(malformedRequestFailure()));
      }
      return launch.then(
        (plane) => plane.workerWire.dispatch(request),
        () => {
          throw new WorkerRejectionError(shutdownFailure());
        },
      );
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: () => {
      // The stopping transition is synchronous: from this instant new
      // inspection work rejects, even before any close step awaits (the
      // E6 law, held at the facade too).
      stopped = true;
      healthAbort.abort(); // a pending health check settles as 'cancelled'
      stopCall ??= (async () => {
        try {
          return await (await launch).stop();
        } catch {
          failedReport ??= neverSpawnedReport();
          return failedReport;
        }
      })();
      return stopCall;
    },
    closed,
  };
}
