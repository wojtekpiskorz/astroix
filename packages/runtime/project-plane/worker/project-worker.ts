import type { InspectionBranches, ProjectWorkerPlane } from './inspection-branches.ts';
import {
  type InspectionFamily,
  invalidationFamiliesFor,
  orderedFamilies,
  type WorkerEvent,
} from './worker-events.ts';
import {
  branchFailure,
  branchFailureDiagnostic,
  cleanupDiagnostic,
  malformedRequestFailure,
  shutdownFailure,
  unconvergedDiagnostic,
  unconvergedFailure,
  WorkerRejectionError,
} from './worker-failure.ts';
import {
  isWorkerInspectionRequest,
  type WorkerInspectionRequest,
  type WorkerInspectionResult,
} from './worker-request.ts';

/**
 * The project-plane worker (#230, ADR-0005's disposable runtime group):
 * ONE failure boundary owning the composition runtime, the fresh
 * inspection runners (each pass's own, closed inside the branches), the
 * watcher subscription to the raw invalidation stream, and the reindex
 * debounce timer — for exactly one disposable project plane.
 *
 * Ownership has three edges, each a tested contract:
 *
 * - **Typed dispatch only** — the four closed request families; anything
 *   else rejects before a branch runs. No generic eval, import, raw Vite
 *   handle, or client-selected path channel exists on the surface.
 * - **Revisioned publication** — invalidations accumulate the raw stream
 *   (E3's monotonic revisions) behind the worker-owned debounce timer
 *   and publish as one event per window: the union of stale families at
 *   the stream's latest revision (CONTEXT.md "reindex"). Diagnostics are
 *   closed-template structured events. Both are plain data — no raw
 *   internal handle crosses.
 * - **Terminal lifecycle** — once `stop()` begins, new work rejects and
 *   the worker closes everything it owns before settling `closed`: the
 *   debounce timer, its stream subscription, in-flight inspections
 *   (aborted, drained under the stop bound), then the plane itself
 *   (invalidation source bindings + composition server). Failure is
 *   terminal — nothing here restarts, re-opens, or re-subscribes; a
 *   crashed worker stays dead by construction (the spawner observes the
 *   exit, E7).
 */

/** Default invalidation publication debounce (ms) — CONTEXT.md "reindex". */
export const DEFAULT_INVALIDATION_DEBOUNCE_MS = 250;
/** Default bound on draining in-flight inspections at stop — ADR-0006 §8's 5 s graceful stop. */
export const DEFAULT_STOP_TIMEOUT_MS = 5000;

export type ProjectWorkerState = 'running' | 'stopping' | 'closed';

/** Why the worker is closing. `stopped` is the caller's stop; the rest are the child layer's terminal paths. */
export type WorkerStopReason = 'stopped' | 'disconnect' | 'crash';

/** The sanitized cleanup-failure categories a close report can name (ADR-0006 §8). */
export type WorkerCleanupCategory = 'in-flight-drain' | 'invalidation-unsubscribe' | 'plane-close';

/** What the stop sequence observed about each owned resource — honest accounting, never a guess. */
export interface WorkerCloseAccounting {
  /** Every in-flight inspection settled within the stop bound. */
  readonly inFlightSettled: boolean;
  /** The worker's stream subscription was removed. */
  readonly unsubscribed: boolean;
  /** The plane's close (invalidation bindings + composition server) resolved. */
  readonly planeClosed: boolean;
}

/** The worker's close report: explicitly complete or incomplete, sanitized categories only (ADR-0006 §8). */
export interface WorkerCloseReport {
  readonly reason: WorkerStopReason;
  readonly outcome: 'complete' | 'incomplete';
  readonly failures: readonly WorkerCleanupCategory[];
  readonly accounting: WorkerCloseAccounting;
}

export interface ProjectWorkerOptions {
  /** The owned project plane (the composition runtime, or the typed-dispatch fake in tests). */
  readonly plane: ProjectWorkerPlane;
  /**
   * Trailing debounce window for invalidation publication (ms); 0
   * publishes each raw event immediately. Defaults to
   * {@link DEFAULT_INVALIDATION_DEBOUNCE_MS}.
   */
  readonly invalidationDebounceMs?: number;
  /** Bound on draining in-flight inspections at stop (ms); defaults to {@link DEFAULT_STOP_TIMEOUT_MS}. */
  readonly stopTimeoutMs?: number;
}

export interface ProjectWorker {
  readonly state: ProjectWorkerState;
  /** Dispatches one typed inspection request; rejects with a `WorkerRejectionError` on failure. */
  dispatch(request: WorkerInspectionRequest, signal?: AbortSignal): Promise<WorkerInspectionResult>;
  /** Subscribes to the worker's public events (invalidations, diagnostics); the return unbinds. */
  subscribe(listener: (event: WorkerEvent) => void): () => void;
  /** Begins the terminal stop; idempotent — every call settles with the one close report. */
  stop(reason?: WorkerStopReason): Promise<WorkerCloseReport>;
  /** Settles with the close report after cleanup completes. */
  readonly closed: Promise<WorkerCloseReport>;
}

/** The per-worker monotonic counters the worker layers above the adapter's own revision disciplines. */
interface RevisionCounters {
  project: number;
  content: number;
}

export function createProjectWorker(options: ProjectWorkerOptions): ProjectWorker {
  const debounceMs = options.invalidationDebounceMs ?? DEFAULT_INVALIDATION_DEBOUNCE_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const listeners = new Set<(event: WorkerEvent) => void>();
  const lifecycle = new AbortController();
  const revisions: RevisionCounters = { project: 0, content: 0 };
  const inFlight = new Set<Promise<unknown>>();
  let currentState: ProjectWorkerState = 'running';
  let stopCall: Promise<WorkerCloseReport> | null = null;

  let resolveClosed: ((report: WorkerCloseReport) => void) | null = null;
  const closed = new Promise<WorkerCloseReport>((resolve) => {
    resolveClosed = resolve;
  });

  // ——— the worker-owned watcher subscription + reindex debounce timer ———

  let pendingFamilies: Set<InspectionFamily> | null = null;
  let pendingRevision = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const flushInvalidations = (): void => {
    debounceTimer = null;
    if (pendingFamilies === null || currentState !== 'running') {
      pendingFamilies = null;
      return;
    }
    publish({
      type: 'invalidation',
      families: orderedFamilies(pendingFamilies),
      revision: pendingRevision,
    });
    pendingFamilies = null;
  };

  const unsubscribeStream = options.plane.invalidations.subscribe((event) => {
    // A stopping worker publishes nothing: the window is dropped at stop.
    if (currentState !== 'running') return;
    const families = invalidationFamiliesFor(event.file);
    // A file no inspection family reads (a shape the widened truth filter
    // never emits) mints no window: a published event carries at least one
    // family by the protocol's construction, and the guard keeps that true
    // even for a drifted source (#387).
    if (families.length === 0) return;
    pendingFamilies ??= new Set();
    for (const family of families) pendingFamilies.add(family);
    pendingRevision = event.revision;
    if (debounceMs <= 0) {
      flushInvalidations();
      return;
    }
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushInvalidations, debounceMs);
  });

  const publish = (event: WorkerEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // a subscriber bug must not break the worker's own event chain
      }
    }
  };

  // ——— typed dispatch ———

  const worker: ProjectWorker = {
    get state(): ProjectWorkerState {
      return currentState;
    },
    dispatch: (request, signal) =>
      dispatchInspection(request, signal, {
        branches: options.plane.inspections,
        lifecycle: lifecycle.signal,
        revisions,
        inFlight,
        guard: () => {
          if (currentState !== 'running') throw new WorkerRejectionError(shutdownFailure());
          if (!isWorkerInspectionRequest(request)) {
            throw new WorkerRejectionError(malformedRequestFailure());
          }
        },
        publish,
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: (reason = 'stopped') => {
      // The stopping transition is synchronous: from this instant new
      // work rejects, even before any close step awaits.
      currentState = 'stopping';
      stopCall ??= closeWorker(reason);
      return stopCall;
    },
    closed,
  };

  return worker;

  // ——— the terminal close sequence (runs once) ———

  async function closeWorker(reason: WorkerStopReason): Promise<WorkerCloseReport> {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pendingFamilies = null; // an unpublished window dies with the run

    lifecycle.abort(); // in-flight inspections observe cancellation

    const inFlightSettled = await drainInFlight();

    let unsubscribed = true;
    try {
      unsubscribeStream();
    } catch {
      unsubscribed = false;
    }

    let planeClosed = true;
    try {
      await options.plane.close();
    } catch {
      planeClosed = false;
    }

    currentState = 'closed';
    const failures = failedCategories(inFlightSettled, unsubscribed, planeClosed);
    for (const category of failures) publish(cleanupDiagnostic(category));
    const report: WorkerCloseReport = {
      reason,
      outcome: failures.length === 0 ? 'complete' : 'incomplete',
      failures,
      accounting: { inFlightSettled, unsubscribed, planeClosed },
    };
    resolveClosed?.(report);
    return report;
  }

  /** Bounded drain: every tracked dispatch settles, or the stop bound expires (an incomplete-report category). */
  async function drainInFlight(): Promise<boolean> {
    if (inFlight.size === 0) return true;
    const settled = Promise.allSettled([...inFlight]).then(() => true);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      expiry = setTimeout(() => resolve(false), stopTimeoutMs);
    });
    const settledFirst = await Promise.race([settled, expired]);
    // A settled drain leaves no dangling bound behind — the timer dies
    // with the race, like the debounce timer above (an in-process
    // embedder's loop must not stay warm for the stop bound).
    clearTimeout(expiry);
    return settledFirst === true;
  }
}

/** The close report's failure categories, in stop-sequence order. */
function failedCategories(
  inFlightSettled: boolean,
  unsubscribed: boolean,
  planeClosed: boolean,
): WorkerCleanupCategory[] {
  const failures: WorkerCleanupCategory[] = [];
  if (!inFlightSettled) failures.push('in-flight-drain');
  if (!unsubscribed) failures.push('invalidation-unsubscribe');
  if (!planeClosed) failures.push('plane-close');
  return failures;
}

// ——— dispatch internals (kept out of the factory closure: pure wiring, covered tier) ———

/** The fixed inputs one dispatch runs with. */
interface DispatchContext {
  readonly branches: InspectionBranches;
  readonly lifecycle: AbortSignal;
  readonly revisions: RevisionCounters;
  readonly inFlight: Set<Promise<unknown>>;
  /** The synchronous admission guard: state check, then request typing. */
  readonly guard: () => void;
  readonly publish: (event: WorkerEvent) => void;
}

async function dispatchInspection(
  request: WorkerInspectionRequest,
  signal: AbortSignal | undefined,
  context: DispatchContext,
): Promise<WorkerInspectionResult> {
  context.guard();
  // The platform merge (Node 24 children; happy-dom implements `any`
  // too): one platform-managed composite instead of a bespoke
  // per-dispatch listener pinned on the lifecycle signal.
  const merged =
    signal === undefined ? context.lifecycle : AbortSignal.any([signal, context.lifecycle]);
  merged.throwIfAborted();

  const run = runFamilyInspection(request, merged, context);
  context.inFlight.add(run);
  try {
    return await run;
  } catch (error) {
    throw dispatchRejection(
      request.kind,
      error,
      { caller: signal, lifecycle: context.lifecycle },
      context,
    );
  } finally {
    context.inFlight.delete(run);
  }
}

/** Runs the request's one branch and layers the family's revision on the result. */
async function runFamilyInspection(
  request: WorkerInspectionRequest,
  signal: AbortSignal,
  context: DispatchContext,
): Promise<WorkerInspectionResult> {
  switch (request.kind) {
    case 'project': {
      const payload = await withCancellation(context.branches.project(), signal);
      context.revisions.project += 1;
      return { kind: 'project', revision: context.revisions.project, payload };
    }
    case 'content': {
      const payload = await withCancellation(context.branches.content(), signal);
      context.revisions.content += 1;
      return { kind: 'content', revision: context.revisions.content, payload };
    }
    case 'routes': {
      const payload = await context.branches.routes({ signal });
      return { kind: 'routes', revision: payload.revision, payload };
    }
    case 'styles': {
      const outcome = await context.branches.styles({
        routeComponent: request.routeComponent,
        attempts: request.attempts,
        signal,
      });
      if (outcome.outcome !== 'converged') {
        throw new WorkerRejectionError(unconvergedFailure(outcome));
      }
      return { kind: 'styles', revision: outcome.payload.revision, payload: outcome.payload };
    }
    case 'route-selection': {
      // The control-plane-only resolution (#370): an unresolvable route is
      // RESULT data (`selection: null` — the executor's 404), never a
      // dispatch failure; only a rejected pass (seam drift, shutdown,
      // abort) rejects here.
      const payload = await context.branches.routeSelection({
        route: request.route,
        signal,
      });
      return { kind: 'route-selection', revision: payload.revision, payload };
    }
  }
}

/**
 * Maps a dispatch failure to its rejection: the caller's own abort
 * reason passes through untouched; a rejection that rode the LIFECYCLE
 * abort (the stop itself, not the caller) settles as the structured
 * `shutdown` failure — a normal stop must never masquerade downstream
 * as a branch failure or a raw abort; an unconverged styles outcome
 * adds its warn diagnostic; any other branch failure is structured
 * (with its error diagnostic) — never a raw error.
 */
function dispatchRejection(
  family: WorkerInspectionRequest['kind'],
  error: unknown,
  signals: { readonly caller: AbortSignal | undefined; readonly lifecycle: AbortSignal },
  context: DispatchContext,
): unknown {
  // The caller's own abort: the caller's reason is the answer, untouched.
  if (signals.caller?.aborted === true) return error;
  // The lifecycle stop killed this dispatch: the structured shutdown
  // failure is the answer — the serving loop forwards it as the
  // request's result, never as a crash exit.
  if (signals.lifecycle.aborted) return new WorkerRejectionError(shutdownFailure());
  if (error instanceof WorkerRejectionError) {
    if (error.failure.code === 'inspection-unconverged') {
      context.publish(unconvergedDiagnostic(error.failure));
    }
    return error;
  }
  const failure = branchFailure(family, error);
  context.publish(branchFailureDiagnostic(failure));
  return new WorkerRejectionError(failure);
}

/**
 * Races signal-abortable branch work (the `project`/`content` branches
 * take no signal): an aborted caller rejects promptly with its own
 * reason while the abandoned pass self-cleans — the fresh-runner
 * discipline closes its runner on every exit path, and its result is
 * discarded (no revision ticks for an unserved pass).
 */
async function withCancellation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    discard(work);
    throw signal.reason;
  }
  return Promise.race([work, abortRejection(signal)]);
}

/** A promise that rejects with the signal's reason when it fires. */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Marks an abandoned pass's eventual settlement as handled — its outcome is discarded. */
function discard(work: Promise<unknown>): void {
  work.catch(() => {
    // the fresh-runner discipline already closed the pass's runner; the abandoned result never publishes
  });
}
