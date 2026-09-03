import type {
  ActivationAttemptSnapshot,
  ActiveSessionSnapshot,
  ProjectKey,
  SessionFailure,
  SessionRef,
  SessionSnapshot,
} from '@wojciechpiskorz/astroix-protocol';
import {
  createHostCapabilityGrants,
  type HostCapabilityGrants,
} from '../../api/http/host-capability.ts';
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
  neverSpawnedReport,
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
 *   replacement clears the active session, records a sanitized failure,
 *   and retires the crashed session's authority (client bindings, project
 *   host capability) — there is **no automatic project restart** (the
 *   ticket's migration policy); a failed activation is retried only by an
 *   explicit new `begin`. The same law covers every attempt that ends
 *   without committing: its reserved reference will never become active,
 *   so its bindings die with it — authority never outlives its session.
 * - **The deactivation-side clear** (#331; ADR-0006 §9 `revoke`): the
 *   composition informs the supervisor that the coordinator's
 *   deactivation linearized — the active entry empties **without**
 *   recording a failure, the same idempotent authority retirement the
 *   crash path holds runs once more as a belt (the ordered pass already
 *   revoked through the shared tables), and listeners hear the clean
 *   snapshot. The stopped run's late close is then history: the crash
 *   observer's replaced-guard bails, so a supervised deactivation never
 *   records a crash. The stop itself is never taken here — the
 *   transition's own stop seam (`stopOldRun`) owns it — and a replay
 *   with no active session answers the sanitized refusal.
 *
 * Deferred to their owning lanes, declared so the boundary is explicit:
 * the external commit ordering — F6 (#238, in
 * `session-supervisor/commit/**` + `revocation/**`); drain and forced
 * transitions — F5 (#237, in `session-supervisor/fence/**`) — none of
 * them this module's territory.
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

/**
 * Why the active session is being cleared deliberately — sanitized
 * vocabulary only, never a value. One context exists today: the
 * coordinator's settled deactivation transition (F6's receipt target of
 * the same name) — the composition informs the supervisor after the
 * linearization revoked authority and initiated the stop.
 */
export type RevokeReason = 'deactivation';

/**
 * The deactivation-side clear's answer: the cleared reference, or the
 * sanitized refusal when no active session exists — replay, a crash that
 * already cleared it, or an authority-less in-flight attempt (its own
 * cancel/rollback machine owns ending that one).
 */
export type RevokeResult =
  | { readonly kind: 'revoked'; readonly revoked: SessionRef }
  | { readonly kind: 'refused'; readonly reason: 'no-active-session' };

/** The supervisor's snapshot-change listener; a throwing listener never breaks the chain (the E6 law). */
export type SessionListener = (snapshot: SessionSnapshot) => void;

/** The staged-activation seam (ADR-0006 §9 `SessionSupervisor`, F4's bounded half). */
export interface SessionSupervisor {
  /** The source of truth: active, attempt, lastFailure — never a flat enum. */
  snapshot(): SessionSnapshot;
  /** Reserves a new generation and starts one candidate privately; refuses while another attempt is in flight. */
  begin(projectKey: ProjectKey): BeginActivationResult;
  /**
   * The deactivation-side clear (ADR-0006 §9's declared shape, landed by
   * #331): empties the active session WITHOUT recording a failure — the
   * coordinator's ordered pass already revoked its authority and
   * initiated its stop; this is the inform that keeps the snapshot
   * honest. Re-revokes the session's own authority retirement as the
   * same idempotent belt the crash path has, notifies with the clean
   * snapshot, and answers a replay with no active session sanitized.
   */
  revoke(reason: RevokeReason): Promise<RevokeResult>;
  /** Subscribes to snapshot changes; the return unbinds. */
  subscribe(listener: SessionListener): () => void;
}

/** Construction options — every seam the focused tests fake. */
export interface SessionSupervisorOptions {
  /** Starts one candidate run per activation; required (the production composition is the integration lane's). */
  readonly startCandidate: StartCandidateRun;
  /** The epoch of this control-plane lifetime; defaults to a fresh mint. */
  readonly runtimeEpoch?: string;
  /**
   * The project host-capability grants committed activations mint into
   * and crashed sessions are revoked from; defaults to a private table.
   * A composition wiring the HTTP dispatch passes THE shared table (F2's
   * grants) — a private default's mints would be invisible to cookie
   * verification, so the default is a construction convenience, never a
   * composition choice.
   */
  readonly hostCapabilities?: HostCapabilityGrants;
  /** The document-bound client registry whose session bindings the supervisor retires; defaults to a private registry. */
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
  const hostCapabilities = options.hostCapabilities ?? createHostCapabilityGrants();
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

  /**
   * The active-entry retirement every clear of `active` runs — the two
   * close paths share it so the invariants cannot drift apart: the
   * session's client bindings and its project host capability die with
   * it (authority never outlives the session that minted it). Idempotent
   * by the tables' own contract — the deactivation's ordered pass
   * already revoked through the shared tables, and this belt is exactly
   * the one the crash path runs.
   */
  const retireActive = (entry: ActiveEntry): void => {
    clients.revokeSession(entry.ref);
    hostCapabilities.revoke({ host: 'project', projectKey: entry.projectKey });
  };

  /**
   * Observes one active run's asynchronous close: without a replacement
   * it is a crash — no restart, ever — and the crashed session's
   * authority dies with it (its client bindings and its project host
   * capability; authority never outlives the session that minted it).
   * Convergence discipline: a REJECTED close observation is still a
   * crash — both branches run the same retirement, so a misbehaving run
   * can neither hang the observer nor surface an unhandled rejection
   * (the real facade's closed resolves by contract; the rejection arm is
   * the belt, not the assumption).
   */
  const observeActiveClose = (entry: ActiveEntry): void => {
    const crashed = (category: SessionFailure['category']): void => {
      if (active !== entry) return; // cleared already: deactivation or replacement — the report is history
      active = null;
      retireActive(entry);
      lastFailure = { category, message: FAILURE_MESSAGES[category] };
      notify();
    };
    void entry.run.closed.then(
      (report) => {
        crashed(report.reason === 'startup-timeout' ? 'startup-timeout' : 'crash');
      },
      () => {
        crashed('crash');
      },
    );
  };

  const hooks: AttemptHooks = {
    commitCandidate: (ref) => {
      const ctx = attemptCtx;
      if (ctx === null || !sameSession(ctx.ref, ref)) {
        // Fail closed AND loud: the attempt machine refuses `not-current`
        // on this answer — the two machines can never diverge silently
        // (unreachable by construction; defense-in-depth).
        return false;
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
        // reports post-commit outcomes — and a rejecting stop stays
        // anchored noise, never an unhandled one).
        clients.revokeSession(outgoing.ref);
        hostCapabilities.revoke({ host: 'project', projectKey: outgoing.projectKey });
        outgoing.run.stop().catch(() => {});
      }
      const entry: ActiveEntry = { ref: ctx.ref, projectKey: ctx.projectKey, run: ctx.run };
      active = entry;
      hostCapabilities.mint({ host: 'project', projectKey: entry.projectKey });
      observeActiveClose(entry);
      notify();
      return true;
    },
    attemptEnded: (end) => {
      if (attemptCtx === null) return;
      const deadRef = attemptCtx.ref;
      attemptCtx = null;
      // The attempt ended without committing: its reference will never
      // become active, so any binding minted against it dies with it —
      // authority never outlives the reference it was bound to.
      clients.revokeSession(deadRef);
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
    revoke: async (_reason) => {
      // The reason is ADR-0006 §9's declared shape; the one context that
      // exists today (a settled deactivation) needs no branching on it —
      // the vocabulary is here for the next ruled context.
      const entry = active;
      if (entry === null) {
        return { kind: 'refused', reason: 'no-active-session' };
      }
      // THE CLEAN CLEAR: the supervisor's deactivation-side inform. The
      // ordered pass already revoked authority and initiated the stop;
      // the entry empties, the belt retirement runs once more (idempotent
      // — the same law the crash path holds), NO failure is recorded, and
      // the crash observer's guard makes the stopped run's late close
      // history rather than a crash.
      active = null;
      retireActive(entry);
      notify();
      return { kind: 'revoked', revoked: entry.ref };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Same-session predicate (the codebase idiom, cf. api-dispatch.ts /
 * canonical-bounds.ts): a `SessionRef` equals another exactly when both
 * its epoch and its generation do — never identity, never partial.
 */
function sameSession(left: SessionRef, right: SessionRef): boolean {
  return left.runtimeEpoch === right.runtimeEpoch && left.generation === right.generation;
}

/** The run a throwing seam converges to: never spawned, explicitly complete (the E8 never-spawned law). */
function neverStartedRun(): ProjectRun {
  const ready = Promise.reject(new ProjectRunBootError('launch-failed'));
  const closed = Promise.resolve(neverSpawnedReport());
  return {
    ready,
    inspect: () => Promise.reject(new WorkerRejectionError(shutdownFailure())),
    subscribe: () => () => {},
    stop: () => closed,
    closed,
  };
}
