import { findDisclosure } from '@wojciechpiskorz/astroix-protocol';
import type { ExactPairValue } from '../astro-project-adapter/adapter-error.ts';
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
 *   {@link ProjectRunBootError}; an uncertified Astro/Vite pair rejects
 *   with the certification code and its pair facts (#319, ADR-0005's
 *   compatibility contract — the launch pre-flight fails the pair
 *   before any child spawns, and the facade's admission is the one
 *   origin-gated, shape-gated mapping into that code).
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

/**
 * Why a run failed to become ready — sanitized codes only (ADR-0006 §7
 * output hygiene). `uncertified-pair` is the adapter's compatibility
 * origin (#319, ADR-0005: an uncertified pair "fails before project
 * config executes"): the production launch's pair pre-flight rejects
 * with the adapter's own `AdapterError('uncertified-pair')`, and the
 * facade's boot-error admission maps exactly that origin — with its pair
 * facts — to this code, so the session layer can report the
 * certification category instead of a launch-shaped default.
 */
export type ProjectRunBootErrorCode =
  | SupervisionBootErrorCode
  | 'proxy-health'
  | 'launch-failed'
  | 'uncertified-pair';

/**
 * The certification facts an uncertified-pair boot rejection carries
 * (ADR-0005's explicit report requirement: the detected pair, the
 * certified pairs, and the rejected contract). These are the adapter's
 * sanctioned `details` payload, re-validated at admission — the strings
 * are disclosure-checked before they ride the error, so nothing a
 * hostile project manifest carried can surface through the boot path.
 */
export interface CertificationFacts {
  readonly detected: ExactPairValue;
  readonly certified: readonly ExactPairValue[];
  readonly rejectedContract: string;
}

/** The fixed templates behind every boot-rejection message — no free text ever enters (the E6 law). */
const BOOT_MESSAGES: Record<ProjectRunBootErrorCode, string> = {
  cancelled: 'the project plane was stopped before it became ready',
  'startup-timeout': 'the project plane did not become ready within the startup deadline',
  'worker-crash': 'the project-runtime worker child terminated before the run completed',
  'managed-astro-crash': 'the managed Astro dev server terminated before the run completed',
  'proxy-health': 'the proxy health prerequisite failed during project startup',
  'launch-failed': 'the project plane could not be launched for the requested project',
  'uncertified-pair': 'the managed project did not carry a certified Astro and Vite pair',
};

/**
 * The sanitized terminal-startup rejection `ready` settles with — the
 * facade's one boot-error shape. The certification code is the one
 * payload-bearing member: its {@link CertificationFacts} are required
 * (the overload pair makes a facts-free certification unconstructible in
 * types), because the code without its facts could never satisfy
 * ADR-0005's report requirement.
 */
export class ProjectRunBootError extends Error {
  readonly certification?: CertificationFacts;

  constructor(code: Exclude<ProjectRunBootErrorCode, 'uncertified-pair'>);
  constructor(code: 'uncertified-pair', certification: CertificationFacts);
  constructor(
    readonly code: ProjectRunBootErrorCode,
    certification?: CertificationFacts,
  ) {
    super(BOOT_MESSAGES[code]);
    this.name = 'ProjectRunBootError';
    // The key rides only when the facts do — an absent payload must not
    // leave an observable `undefined` property behind.
    if (certification !== undefined) this.certification = certification;
  }
}

/** The adapter's compatibility origin — the only certification-bearing code admitted. */
const UNCERTIFIED_PAIR_CODE = 'uncertified-pair';

/** A fact string the certification payload may carry: non-empty and disclosure-free. */
function isFactText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && findDisclosure(value) === null;
}

/** One pair value in the certification payload — both versions fact strings. */
function isFactPair(value: unknown): value is ExactPairValue {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return isFactText(record.astro) && isFactText(record.vite);
}

/**
 * Validates a boot-path rejection into the certification facts — or null
 * when the origin is anything else: another adapter code, no code at
 * all, or an `uncertified-pair` whose payload drifted in shape or carries
 * disclosure-shaped text. The admission never guesses (#319): a drifted
 * origin reports `launch-failed`, never a partially-trusted
 * certification.
 */
function certificationFactsOf(error: unknown): CertificationFacts | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;
  if (record.code !== UNCERTIFIED_PAIR_CODE) return null;
  const details = record.details;
  if (typeof details !== 'object' || details === null) return null;
  return certificationPayloadOf(details as Record<string, unknown>);
}

/**
 * The adapter's uncertified-pair detail payload, validated whole: the
 * detected pair, a non-empty certified list of pairs, and the rejected
 * contract — every string a non-empty, disclosure-free fact.
 */
function certificationPayloadOf(payload: Record<string, unknown>): CertificationFacts | null {
  if (!isFactPair(payload.detected)) return null;
  if (!Array.isArray(payload.certified) || payload.certified.length === 0) return null;
  const certified: ExactPairValue[] = [];
  for (const pair of payload.certified) {
    if (!isFactPair(pair)) return null;
    certified.push({ astro: pair.astro, vite: pair.vite });
  }
  if (!isFactText(payload.rejectedContract)) return null;
  return {
    detected: { astro: payload.detected.astro, vite: payload.detected.vite },
    certified,
    rejectedContract: payload.rejectedContract,
  };
}

/**
 * Maps a boot-path rejection (the launch pre-flight's or the plane's own
 * readiness) to the facade's boot error: the adapter's `uncertified-pair`
 * origin with a well-formed payload becomes the certification code;
 * the supervisor's codes pass through by membership; everything else —
 * including a drifted certification payload — is launch-shaped.
 */
function toBootError(error: unknown): ProjectRunBootError {
  const facts = certificationFactsOf(error);
  if (facts !== null) {
    return new ProjectRunBootError('uncertified-pair', facts);
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  // The supervisor's boot codes are admitted by membership in the
  // compiler-forced BOOT_MESSAGES key set — the Record's own exhaustiveness
  // is the allowlist, so a future E7 boot code template compiles here for
  // free instead of drifting silently in a hand-listed array. hasOwn, not
  // `in`: the prototype chain makes 'constructor' in obj true.
  // `uncertified-pair` itself is exempt from the membership path on
  // purpose: its admission is the shape-gated branch above, so a rejection
  // wearing the code without a valid payload falls closed instead of
  // riding the table into a facts-free certification.
  if (
    typeof code === 'string' &&
    code !== UNCERTIFIED_PAIR_CODE &&
    Object.hasOwn(BOOT_MESSAGES, code)
  ) {
    return new ProjectRunBootError(code as Exclude<ProjectRunBootErrorCode, 'uncertified-pair'>);
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
    (error: unknown) => {
      // The launch rejection rides the SAME admission as the plane's own
      // boot failures: the pre-flight's `uncertified-pair` origin maps to
      // the certification boot error with its pair facts, and everything
      // else (an unresolvable dependency, a hostile free-text error)
      // stays `launch-failed` — never a guess (#319).
      throw toBootError(error);
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
