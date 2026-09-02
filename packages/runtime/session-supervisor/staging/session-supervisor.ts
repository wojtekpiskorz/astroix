import type {
  ActivationAttemptSnapshot,
  ActiveSessionSnapshot,
  ProjectKey,
  SessionFailure,
  SessionRef,
  SessionSnapshot,
} from '@wojciechpiskorz/astroix-protocol';
import type { HostCapabilityGrants } from '../../api/http/host-capability.ts';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import {
  shutdownFailure,
  WorkerRejectionError,
} from '../../project-plane/worker/worker-failure.ts';
import { type ProjectRun, ProjectRunBootError } from '../../project-runtime/project-runtime.ts';
import { createSessionClients, type SessionClients } from '../clients/session-clients.ts';
import {
  type ActivationAttempt,
  type AttemptHooks,
  createActivationAttempt,
  FAILURE_MESSAGES,
  rollbackFailureCategory,
} from './activation-attempt.ts';
import { mintRuntimeEpoch } from './runtime-epoch.ts';

export type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
export type { ProjectRun } from '../../project-runtime/project-runtime.ts';
export type { SessionClients } from '../clients/session-clients.ts';
// The seam entry's own contract (the #305 re-export idiom): a consumer of
// `session-supervisor/staging` names the whole public vocabulary — the
// attempt, the staged candidate, the outcomes, the rejection species —
// without reaching around the exports map. The snapshot and reference
// types are the protocol's (read-only; #220 owns them).
export type {
  ActivationAttempt,
  ActivationOutcome,
  CancelReason,
  CommitResult,
  RollbackReason,
  StagedCandidate,
  StageRejectionCode,
} from './activation-attempt.ts';
export {
  ActivationFailedError,
  FAILURE_MESSAGES,
  rollbackFailureCategory,
  StageRejectedError,
} from './activation-attempt.ts';
export { mintRuntimeEpoch } from './runtime-epoch.ts';

/**
 * The SessionSupervisor's staging half (#236, F4; ADR-0006 §4/§9 — one of
 * the runtime's named deep seams): the serialized, staged activation
 * transaction over one active project session.
 *
 * - **Snapshot as the source of truth** (§4): `snapshot()` reports
 *   `active`, `attempt`, and `lastFailure` — never a flat state enum; the
 *   launcher derives labels elsewhere (the protocol's `sessionLabel`).
 * - **Generation reservation** (§3/§4 step 1): every attempt — committed,
 *   failed, or cancelled — consumes a fresh generation; `begin` refuses a
 *   concurrent activation (`concurrent-activation`, HTTP 409 by the
 *   protocol's `ERROR_HTTP_STATUS` mapping — transport truth, not a
 *   supervisor concern).
 * - **Private candidate readiness** (§4 step 1): the candidate run starts
 *   at `begin` and readies while the old session stays authoritative —
 *   the snapshot keeps `active` untouched and `attempt` at `starting`
 *   until a commit begins.
 * - **Rollback before commit** (§4 step 1/7): candidate failure or an
 *   explicit rollback discards the candidate and preserves the old ready
 *   session untouched.
 * - **The commit linearization** (§4 step 5, the state side only):
 *   `StagedCandidate.commit()` is the one synchronous authority swap —
 *   supervisor-internal authority (the outgoing session's client
 *   bindings, the outgoing project host capability) is revoked, the
 *   outgoing run's stop is initiated, and the candidate becomes the
 *   active session. The ordered external handoff — the one-use
 *   `SwitchPreparationReceipt`, routes, streams, sockets, edit grants —
 *   is F6's (#238): it consumes its receipt and then drives this call.
 *   Staging takes no receipt parameter because it cannot validate a
 *   proof it never minted (the declared-seam precedent of E8's
 *   proxy-health).
 * - **Crash observation**: an active run that closes without a
 *   replacement clears the active session and records a sanitized
 *   failure — there is **no automatic project restart** (the ticket's
 *   migration policy); a failed activation is retried only by an
 *   explicit new `begin`.
 *
 * Deferred to their owning lanes, declared so the boundary is explicit:
 * `revoke`/deactivation and the external commit ordering — F6 (#238);
 * drain and forced transitions — F5 (#237), in
 * `session-supervisor/fence/**` and `session-supervisor/commit/**` +
 * `revocation/**` — none of them this module's territory.
 *
 * Deterministic by construction: no timers, no sockets — the composition
 * injects the candidate-run factory (registry resolution, ProjectRuntime
 * wiring, and port discipline are the integration lane's), the host
 * capability grants, and the client registry. The focused tests fake
 * exactly those seams.
 */

/** One candidate-start request: what the composition needs to launch a run for the reserved reference. */
export interface CandidateStartRequest {
  readonly projectKey: ProjectKey;
  readonly sessionRef: SessionRef;
}

/**
 * Starts one candidate {@link ProjectRun} per activation. Contract (the
 * E8 launch law): hand back a run even on failure — startup failures
 * surface through the run's `ready` rejection, never a throw. A throwing
 * seam is still survived (the generation is consumed and the attempt
 * fails sanitized), but that is a composition defect.
 */
export type StartCandidateRun = (request: CandidateStartRequest) => ProjectRun;

/** What `begin` answered: the begun attempt, or the concurrent-activation refusal (the protocol's 409). */
export type BeginActivationResult =
  | { readonly kind: 'begun'; readonly attempt: ActivationAttempt }
  | { readonly kind: 'refused'; readonly reason: 'concurrent-activation' };

/** The supervisor's snapshot-change listener; a throwing listener never breaks the chain (the E6 law). */
export type SessionListener = (snapshot: SessionSnapshot) => void;

/** The staged-activation seam (ADR-0006 §9 `SessionSupervisor`, F4's bounded half). */
export interface SessionSupervisor {
  /** The source of truth: active, attempt, lastFailure — never a flat enum. */
  snapshot(): SessionSnapshot;
  /** Reserves a new generation and starts one candidate privately; refuses while another attempt is in flight. */
  begin(projectKey: ProjectKey): BeginActivationResult;
  /** Subscribes to snapshot changes; the return unbinds. */
  subscribe(listener: SessionListener): () => void;
}

/** Construction options — every seam the focused tests fake. */
export interface SessionSupervisorOptions {
  /** Starts one candidate run per activation; required (the production composition is the integration lane's). */
  readonly startCandidate: StartCandidateRun;
  /** The epoch of this control-plane lifetime; defaults to a fresh mint. */
  readonly runtimeEpoch?: string;
  /** The project host-capability grants committed activations mint into; defaults to a private table. */
  readonly hostCapabilities?: HostCapabilityGrants;
  /** The document-bound client registry whose session bindings commit revokes; defaults to a private registry. */
  readonly clients?: SessionClients;
}

/** One committed, authority-bearing session the supervisor tracks internally. */
interface ActiveEntry {
  readonly ref: SessionRef;
  readonly projectKey: ProjectKey;
  readonly run: ProjectRun;
}

/** The one in-flight attempt's context — its reserved reference, project, and candidate run. */
interface AttemptContext {
  readonly ref: SessionRef;
  readonly projectKey: ProjectKey;
  readonly run: ProjectRun;
  /** The commit began — the snapshot's one `committing` source until the swap completes. */
  committing: boolean;
}

/** Builds the staged-activation supervisor. */
export function createSessionSupervisor(options: SessionSupervisorOptions): SessionSupervisor {
  const runtimeEpoch = options.runtimeEpoch ?? mintRuntimeEpoch();
  const hostCapabilities = options.hostCapabilities;
  const clients = options.clients ?? createSessionClients();
  const listeners = new Set<SessionListener>();

  let nextGeneration = 1;
  let active: ActiveEntry | null = null;
  let attemptCtx: AttemptContext | null = null;
  let lastFailure: SessionFailure | null = null;

  const snapshot = (): SessionSnapshot => {
    const current: SessionSnapshot = {};
    if (active !== null) {
      const activeSnapshot: ActiveSessionSnapshot = {
        ref: active.ref,
        projectKey: active.projectKey,
        state: 'ready',
      };
      current.active = activeSnapshot;
    }
    if (attemptCtx !== null) {
      const attemptSnapshot: ActivationAttemptSnapshot = {
        ref: attemptCtx.ref,
        projectKey: attemptCtx.projectKey,
        state: attemptCtx.committing ? 'committing' : 'starting',
      };
      current.attempt = attemptSnapshot;
    }
    if (lastFailure !== null) current.lastFailure = lastFailure;
    return current;
  };

  const notify = (): void => {
    const frame = snapshot();
    for (const listener of listeners) {
      try {
        listener(frame);
      } catch {
        // a subscriber bug must not break the supervisor's chain (the E6 law)
      }
    }
  };

  /** Observes one active run's asynchronous close: without a replacement it is a crash — no restart, ever. */
  const observeActiveClose = (entry: ActiveEntry): void => {
    void entry.run.closed.then((report) => {
      if (active !== entry) return; // replaced already: authority moved, the report is history
      active = null;
      const category: SessionFailure['category'] =
        report.reason === 'startup-timeout' ? 'startup-timeout' : 'crash';
      lastFailure = { category, message: FAILURE_MESSAGES[category] };
      notify();
    });
  };

  const hooks: AttemptHooks = {
    commitCandidate: (ref) => {
      const ctx = attemptCtx;
      if (
        ctx === null ||
        ctx.ref.runtimeEpoch !== ref.runtimeEpoch ||
        ctx.ref.generation !== ref.generation
      ) {
        return; // fail closed: only the live attempt commits
      }
      // The committing phase is observable: the snapshot reports the
      // attempt as `committing` from here until the swap completes.
      ctx.committing = true;
      notify();
      const outgoing = active;
      attemptCtx = null;
      if (outgoing !== null) {
        // Outgoing supervisor-internal authority dies now — its client
        // bindings and its project host capability — and its run's
        // teardown continues in the background (anchored; a replaced
        // session's report is internal history, the completion lane F7
        // reports post-commit outcomes).
        clients.revokeSession(outgoing.ref);
        hostCapabilities?.revoke({ host: 'project', projectKey: outgoing.projectKey });
        outgoing.run.stop().catch(() => {});
      }
      const entry: ActiveEntry = { ref: ctx.ref, projectKey: ctx.projectKey, run: ctx.run };
      active = entry;
      hostCapabilities?.mint({ host: 'project', projectKey: entry.projectKey });
      observeActiveClose(entry);
      notify();
    },
    attemptEnded: (end) => {
      if (attemptCtx === null) return;
      attemptCtx = null;
      if (end.kind === 'failed') {
        lastFailure = end.failure;
      } else if (end.kind === 'rolled-back') {
        const category = rollbackFailureCategory(end.reason);
        if (category !== null) lastFailure = { category, message: FAILURE_MESSAGES[category] };
      }
      // A cancelled attempt records no failure — it is not one; the old
      // session (if any) was never touched.
      notify();
    },
  };

  return {
    snapshot,
    begin: (projectKey) => {
      if (attemptCtx !== null) {
        return { kind: 'refused', reason: 'concurrent-activation' };
      }
      const generation = nextGeneration;
      nextGeneration += 1;
      const ref: SessionRef = { runtimeEpoch, generation };
      let run: ProjectRun;
      try {
        run = options.startCandidate({ projectKey, sessionRef: ref });
      } catch {
        // A throwing seam is a composition defect; the generation is
        // still consumed and the attempt still fails sanitized.
        run = neverStartedRun();
      }
      attemptCtx = { ref, projectKey, run, committing: false };
      const attempt = createActivationAttempt({ ref, run, hooks });
      notify();
      return { kind: 'begun', attempt };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The run a throwing seam converges to: never spawned, explicitly complete (the E8 never-spawned law). */
function neverStartedRun(): ProjectRun {
  const ready = Promise.reject(new ProjectRunBootError('launch-failed'));
  const report: SupervisionCloseReport = {
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
  const closed = Promise.resolve(report);
  return {
    ready,
    inspect: () => Promise.reject(new WorkerRejectionError(shutdownFailure())),
    subscribe: () => () => {},
    stop: () => closed,
    closed,
  };
}
