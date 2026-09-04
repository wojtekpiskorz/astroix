import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import {
  type PlaneAdmissionState,
  type PlaneSupervisorState,
  type ProjectPlaneSupervisor,
  SupervisionBootError,
  type SupervisionBootErrorCode,
} from '../../project-plane/supervision/plane-supervisor.ts';
import type { SupervisedWorkerWire } from '../../project-plane/supervision/worker-wire.ts';
import type { WorkerEvent } from '../../project-plane/worker/worker-events.ts';
import {
  shutdownFailure,
  type WorkerFailure,
  WorkerRejectionError,
} from '../../project-plane/worker/worker-failure.ts';
import type {
  WorkerInspectionRequest,
  WorkerInspectionResult,
} from '../../project-plane/worker/worker-request.ts';

/**
 * The #232 focused-test stand-in, at the sanctioned level: fakes at the
 * seams the facade CONSUMES — the plane supervisor (lifecycle: ready /
 * stop / closed / workerWire) and the worker-wire facet (typed dispatch
 * + public events) — the recorded E6 dispatch-boundary idiom, not a
 * composition fake. Every knob below exists to prove a facade contract:
 * readiness sequencing, health gating, stop convergence, typed-only
 * dispatch, event forwarding. The wire fake honors the facet's own
 * contract (structured shutdown rejections once closing/dead) so the
 * facade's passthrough is judged against the real seam law.
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

export interface FakeWorkerWire {
  wire: SupervisedWorkerWire;
  /** Every dispatch the wire received, in order. */
  readonly requests: WorkerInspectionRequest[];
  /** Reject the next dispatch with this structured failure; null (default) serves the family result. */
  nextFailure: WorkerFailure | null;
  /** The facet's closing/dead gates — flip to make dispatch reject as structured shutdown. */
  gate: 'open' | 'closing' | 'dead';
  /** Emits one public worker event to the current subscribers. */
  emit(event: WorkerEvent): void;
  /** Live subscriber count (subscription accounting). */
  listenerCount(): number;
}

export function fakeWorkerWire(): FakeWorkerWire {
  const requests: WorkerInspectionRequest[] = [];
  const listeners = new Set<(event: WorkerEvent) => void>();
  const revisions = { project: 0, content: 0, routes: 0, styles: 0 };
  const fake: FakeWorkerWire = {
    wire: undefined as unknown as SupervisedWorkerWire,
    requests,
    nextFailure: null,
    gate: 'open',
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };

  const familyResult = (request: WorkerInspectionRequest): WorkerInspectionResult => {
    switch (request.kind) {
      case 'project':
        revisions.project += 1;
        return {
          kind: 'project',
          revision: revisions.project,
          payload: { certified: { astro: '7.2.10', vite: '8.2.2' } },
        };
      case 'content':
        revisions.content += 1;
        return {
          kind: 'content',
          revision: revisions.content,
          payload: {
            collections: [],
            diagnostics: [],
            revision: 'b1946ac92492d2347c6235b4d2611184'.padEnd(64, '0'),
          },
        };
      case 'routes':
        revisions.routes += 1;
        return {
          kind: 'routes',
          revision: revisions.routes,
          payload: { revision: revisions.routes, routes: [] },
        };
      case 'styles':
        revisions.styles += 1;
        return {
          kind: 'styles',
          revision: revisions.styles,
          payload: { revision: revisions.styles, invalidationRevision: 0, records: [] },
        };
      case 'route-selection':
        // #370: the facade passes the control-plane-only resolution
        // through — a resolved root selection is a fine stand-in; these
        // fakes prove the FACADE, never the seam.
        return {
          kind: 'route-selection',
          revision: 1,
          payload: {
            revision: 1,
            selection: { pattern: '/', component: 'src/pages/index.astro' },
          },
        };
    }
  };

  const wire: SupervisedWorkerWire = {
    get connected(): boolean {
      return fake.gate !== 'dead';
    },
    send: () => false, // raw sends are not the facade's path; dispatch() is
    on: () => {}, // no raw-message/disconnect consumers at this boundary
    removeListener: () => {},
    dispatch: (request) => {
      // The facet's own gate law: once any close path began or the wire
      // died, dispatches reject as structured shutdown — never dangle.
      if (fake.gate !== 'open') {
        return Promise.reject(new WorkerRejectionError(shutdownFailure()));
      }
      requests.push(request);
      if (fake.nextFailure !== null) {
        const failure = fake.nextFailure;
        fake.nextFailure = null;
        return Promise.reject(new WorkerRejectionError(failure));
      }
      return Promise.resolve(familyResult(request));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  fake.wire = wire;
  return fake;
}

export interface FakePlane {
  supervisor: ProjectPlaneSupervisor;
  readonly wire: FakeWorkerWire;
  /** Resolves the supervisor's readiness (the plane's prerequisites are met). */
  settleReady(): void;
  /** Rejects the supervisor's readiness with E7's sanitized boot error for the code. */
  failReady(code: SupervisionBootErrorCode): void;
  /** Settles stop/closed with one report — the terminal transition, caller stop or crash. */
  closeWith(report: SupervisionCloseReport): void;
  /** How many times the supervisor's stop was called. */
  readonly stopCalls: number;
}

export function fakePlane(): FakePlane {
  const wire = fakeWorkerWire();
  let stopCalls = 0;
  let readySettled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: SupervisionBootError) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {}); // anchored: the facade surfaces it, the fake never hangs a test
  let resolveClosed: (report: SupervisionCloseReport) => void = () => {};
  const closed = new Promise<SupervisionCloseReport>((resolve) => {
    resolveClosed = resolve;
  });
  // E7's own law, held by the fake: any close path rejects an unsettled
  // readiness — the caller's stop as 'cancelled', a crash under its
  // reason — before the report settles.
  const rejectPendingReady = (code: SupervisionBootErrorCode): void => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new SupervisionBootError(code));
  };
  // stop and closed settle the SAME report — the supervisor's contract,
  // held by construction in the fake too.
  const stop = (): Promise<SupervisionCloseReport> => {
    stopCalls += 1;
    rejectPendingReady('cancelled');
    return closed;
  };
  const supervisor: ProjectPlaneSupervisor = {
    get state(): PlaneSupervisorState {
      return 'running';
    },
    get admission(): PlaneAdmissionState {
      return 'admitted';
    },
    ready,
    workerWire: wire.wire,
    stop,
    closed,
  };
  return {
    supervisor,
    wire,
    settleReady: () => {
      readySettled = true;
      resolveReady();
    },
    failReady: (code) => {
      readySettled = true;
      rejectReady(new SupervisionBootError(code));
    },
    closeWith: (report) => {
      rejectPendingReady(report.reason === 'stopped' ? 'cancelled' : report.reason);
      resolveClosed(report);
    },
    get stopCalls() {
      return stopCalls;
    },
  };
}
