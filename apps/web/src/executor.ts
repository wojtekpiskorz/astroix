import type {
  ProjectKey,
  PublicError,
  RequestEnvelope,
  ResponseEnvelope,
  SessionRef,
  SseEvent,
} from '@wojciechpiskorz/astroix-protocol';
import type { ClientBindings } from '@wojciechpiskorz/astroix-runtime/api/http';
import { pagedProjectList } from '@wojciechpiskorz/astroix-runtime/api/pagination';
import {
  createGrantTable,
  type GrantTable,
} from '@wojciechpiskorz/astroix-runtime/edit-authority/grants';
import type { OriginLease, OriginListener } from '@wojciechpiskorz/astroix-runtime/origin';
import type { ProjectRun } from '@wojciechpiskorz/astroix-runtime/project-runtime';
import type { ProjectRegistry } from '@wojciechpiskorz/astroix-runtime/registry';
import type { SessionClients } from '@wojciechpiskorz/astroix-runtime/session-supervisor/clients';
import type {
  CommittedTransition,
  SwitchCoordinator,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/commit';
import {
  createEditFence,
  type EditDrain,
  type EditFence,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/fence';
import {
  ActivationFailedError,
  type SessionSupervisor,
  type StagedCandidate,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/staging';
import type { SseHub } from '@wojciechpiskorz/astroix-runtime/sse';
import { ssePublication } from '@wojciechpiskorz/astroix-runtime/sse';
import { candidateRun, clearCandidates, runPort } from './run-ports.ts';

/**
 * The command executor of the web host (#240): the composition behind
 * the F2 dispatch's `executeCommand` seam — where the closed browser
 * command set meets the control plane. `list-projects` reads the
 * injected registry through F3's bounded page builder; `activate` and
 * `deactivate` drive the settled transition protocol (ADR-0006 §4) over
 * the landed F4/F5/F6 surfaces — stage privately, drain the old
 * session's fence, mint the one-use receipt, consume it at the commit
 * linearization point, then grant the new origin lease strictly after
 * the coordinator revoked the old one; `inspect` dispatches the typed
 * families onto the active run.
 *
 * Two families are deliberately NOT composed here, and answer the
 * closed catch-all rather than a lie:
 * - `apply-edit`: the edit-authority executor composition is the edit
 *   verticals' lane; no browser flow can issue one yet.
 * - The `styles` inspection family: its worker request needs the
 *   active route's component — a selection the closed protocol v1
 *   request envelope cannot carry. Binding that wire-carried selection
 *   is the CSS vertical's contract work.
 */

/** One committed session's composition record — everything a transition binds (ADR-0006 §4 step 5). */
export interface SessionSeat {
  readonly ref: SessionRef;
  readonly projectKey: ProjectKey;
  readonly run: ProjectRun;
  /** The run's dev-server loopback port — the origin lease's upstream (caller-owned, ADR-0005). */
  readonly devServerPort: number;
  /** The origin lease this session holds — the switch's routes-revocation target. */
  readonly lease: OriginLease;
  /** The session's edit fence — the drain's subject on every transition. */
  readonly fence: EditFence;
  /** The editor HTTP-binding capability the project document serves (the web host's #246 stand-in). */
  readonly editorCapability: string;
  /** The supervisor-side editor document the session's client capability is bound to. */
  readonly document: { readonly webContentsId: number; readonly navigationId: number };
  /** The session-clients capability for the same document — the receipt's authoritative client. */
  readonly clientCapability: string;
}

/** The seat store the executor reads and the composition owns. */
export interface SeatStore {
  active(): SessionSeat | null;
  adopt(seat: SessionSeat): void;
  drop(ref: SessionRef): void;
}

/** Everything the executor drives. */
export interface ExecutorInputs {
  readonly registry: ProjectRegistry;
  readonly supervisor: SessionSupervisor;
  readonly coordinator: SwitchCoordinator;
  readonly seatStore: SeatStore;
  readonly listener: OriginListener;
  readonly sessionClients: SessionClients;
  readonly httpBindings: ClientBindings;
  readonly grantTables: Map<string, GrantTable>;
  readonly pendingDevPorts: number[];
  readonly freePort: () => Promise<number>;
  readonly hub: SseHub;
}

/** The executor surface — one call per admitted envelope. */
export interface CommandExecutor {
  execute(envelope: RequestEnvelope): Promise<ResponseEnvelope | PublicError>;
}

/** Builds the command executor. */
export function createExecutor(inputs: ExecutorInputs): CommandExecutor {
  return { execute: (envelope) => dispatch(envelope, inputs) };
}

/** The one dispatch — the closed command set; nothing else reaches here (F2's matrix). */
async function dispatch(
  envelope: RequestEnvelope,
  inputs: ExecutorInputs,
): Promise<ResponseEnvelope | PublicError> {
  switch (envelope.command.kind) {
    case 'list-projects':
      return listProjects(envelope, inputs);
    case 'activate':
      return activate(envelope, inputs);
    case 'deactivate':
      return deactivate(envelope, inputs);
    case 'inspect':
      return inspect(envelope, inputs);
    case 'apply-edit':
      return notComposed();
  }
}

/** The idle registry read, answered through F3's bounded page builder (paginate before the cap). */
async function listProjects(
  envelope: RequestEnvelope,
  inputs: ExecutorInputs,
): Promise<ResponseEnvelope | PublicError> {
  const summaries = await inputs.registry.projectSummaries();
  if (!summaries.ok) return notComposed();
  const page = pagedProjectList({
    requestId: envelope.requestId,
    projects: summaries.summaries,
  });
  // One wire envelope is one page under the lifecycle cap: protocol v1's
  // closed request envelopes carry no page parameters (F3's ruling — the
  // cursor vocabulary stays contract-owned), so the fitting page is the
  // complete answer the frozen wire can carry.
  return page.kind === 'refused' ? notComposed() : page.envelope;
}

/** The settled activation transition (ADR-0006 §4): stage, drain, receipt, commit, adopt. */
async function activate(
  envelope: RequestEnvelope,
  inputs: ExecutorInputs,
): Promise<ResponseEnvelope | PublicError> {
  if (envelope.command.kind !== 'activate') throw new Error('dispatch defect');
  const { projectKey } = envelope.command;
  const record = inputs.registry
    .snapshot()
    .records.find((entry) => entry.projectKey === projectKey);
  if (record === undefined) return notFoundProject();
  clearCandidates();
  // The port is picked BEFORE `begin` — the supervisor's `startCandidate`
  // seam consumes it synchronously inside `begin`. A refused begin
  // returns it: the queue always holds exactly the ports of admitted
  // attempts, never a stale leftover.
  const devPort = await inputs.freePort();
  inputs.pendingDevPorts.push(devPort);
  const begun = inputs.supervisor.begin(projectKey);
  if (begun.kind === 'refused') {
    const returned = inputs.pendingDevPorts.pop();
    if (returned !== devPort) throw new Error('dispatch defect: port queue desync');
    return concurrentActivation();
  }
  let candidate: StagedCandidate;
  try {
    candidate = await begun.attempt.ready;
  } catch (error) {
    // A failed activation is not a public error: the snapshot's
    // lastFailure is the answer (ADR-0006 §4's `failed` label) and the
    // attempt already ended sanitized (F4's law).
    if (!(error instanceof ActivationFailedError)) return notComposed();
    return activationResult(envelope.requestId, begun.attempt.ref, projectKey, inputs);
  }
  const committed = await commitTransition(candidate, inputs);
  if (!committed) {
    // Either the drain aborted (rollback + resume, §4 step 3 — the old
    // session is untouched) or authority was revoked and the grant
    // failed (§4 step 7 — irreversible, F7's aftermath): the snapshot
    // distinguishes them, and it is the answer either way.
    return activationResult(envelope.requestId, candidate.ref, projectKey, inputs);
  }
  return activationResult(envelope.requestId, candidate.ref, projectKey, inputs);
}

/** The transition's commit half: the plain first commit, or the receipt-gated switch. */
async function commitTransition(
  candidate: StagedCandidate,
  inputs: ExecutorInputs,
): Promise<boolean> {
  const oldSeat = inputs.seatStore.active();
  let outcome: 'committed' | 'failed';
  if (oldSeat === null) {
    outcome = await commitFirstActivation(candidate);
  } else {
    outcome = await commitSwitch(oldSeat, candidate, inputs);
  }
  if (outcome !== 'committed') return false;
  try {
    await adoptSession(candidate, recordRoot(candidate, inputs), inputs);
    return true;
  } catch {
    return false;
  }
}

/** The root of the candidate's project record — the composition's own lookup, never browser-supplied. */
function recordRoot(candidate: StagedCandidate, inputs: ExecutorInputs): string {
  const active = inputs.supervisor.snapshot().active;
  const key = active !== undefined && samePair(active.ref, candidate.ref) ? active.projectKey : '';
  const record = inputs.registry.snapshot().records.find((entry) => entry.projectKey === key);
  if (record === undefined) throw new Error('the committed session has no registry record');
  return record.canonicalRoot;
}

/** The first activation's plain commit — no old session exists, so there is nothing to drain or revoke. */
async function commitFirstActivation(candidate: StagedCandidate): Promise<'committed' | 'failed'> {
  try {
    await candidate.commit();
    return 'committed';
  } catch {
    return 'failed';
  }
}

/** The receipt-gated switch (§4 steps 2–5): drain, mint, consume — the old lease revokes inside the coordinator. */
async function commitSwitch(
  oldSeat: SessionSeat,
  candidate: StagedCandidate,
  inputs: ExecutorInputs,
): Promise<'committed' | 'failed'> {
  const drain = await drainCleanly(oldSeat.fence);
  if (drain === null) {
    // A drain conflict aborts the transition: roll the candidate back
    // and resume the untouched old session (§4 step 3) — resume rides
    // the terminal drain, re-opening admission.
    await candidate.rollback('drain-conflict').catch(() => {});
    return 'failed';
  }
  const prepared = await inputs.coordinator.prepareNormal({
    oldSession: oldSeat.ref,
    target: { kind: 'replacement', candidate: candidate.ref },
    client: {
      document: oldSeat.document,
      capability: oldSeat.clientCapability,
      httpCapability: oldSeat.editorCapability,
    },
    fence: oldSeat.fence,
    drain,
    host: { host: 'project', projectKey: oldSeat.projectKey },
    routes: oldSeat.lease,
  });
  if (prepared.kind !== 'prepared') {
    await candidate.rollback('cancelled').catch(() => {});
    drain.resume();
    return 'failed';
  }
  const result: CommittedTransition = await inputs.coordinator.commit(prepared.receipt, candidate);
  inputs.seatStore.drop(oldSeat.ref);
  return result.kind === 'committed' ? 'committed' : 'failed';
}

/** The settled deactivation transition: drain, mint, consume, stop — no successor. */
async function deactivate(
  envelope: RequestEnvelope,
  inputs: ExecutorInputs,
): Promise<ResponseEnvelope | PublicError> {
  const seat = inputs.seatStore.active();
  if (seat === null) return staleSession();
  const drain = await drainCleanly(seat.fence);
  if (drain === null) {
    return notComposed();
  }
  const prepared = await inputs.coordinator.prepareNormal({
    oldSession: seat.ref,
    target: { kind: 'deactivation' },
    client: {
      document: seat.document,
      capability: seat.clientCapability,
      httpCapability: seat.editorCapability,
    },
    fence: seat.fence,
    drain,
    host: { host: 'project', projectKey: seat.projectKey },
    routes: seat.lease,
    stopOldRun: () => {
      void seat.run.stop().catch(() => {});
    },
  });
  if (prepared.kind !== 'prepared') {
    drain.resume();
    return notComposed();
  }
  const result = await inputs.coordinator.deactivate(prepared.receipt);
  inputs.seatStore.drop(seat.ref);
  if (result.kind !== 'deactivated') return notComposed();
  return {
    protocolVersion: 1,
    requestId: envelope.requestId,
    session: seat.ref,
    result: {
      kind: 'deactivation',
      target: { session: seat.ref, projectKey: seat.projectKey },
      snapshot: inputs.supervisor.snapshot(),
    },
  };
}

/** The typed inspection dispatch onto the active run — three families map 1:1; `styles` defers to its vertical. */
async function inspect(
  envelope: RequestEnvelope,
  inputs: ExecutorInputs,
): Promise<ResponseEnvelope | PublicError> {
  if (envelope.command.kind !== 'inspect') throw new Error('dispatch defect');
  const seat = inputs.seatStore.active();
  if (seat === null || !samePair(seat.ref, envelope.session)) return staleSession();
  const request = envelope.command.request;
  if (request.kind === 'styles') return notComposed();
  try {
    const result = await seat.run.inspect(request);
    return {
      protocolVersion: 1,
      requestId: envelope.requestId,
      session: seat.ref,
      result: { kind: 'inspection', result },
    };
  } catch {
    return notComposed();
  }
}

/**
 * Adopts one committed session: the editor document binding (both
 * truths — the HTTP table and the supervisor's registry), the grant
 * table, the origin lease (granted strictly after the coordinator
 * revoked the old one), the seat, and the worker event lift onto the
 * hub under the exact pair.
 */
async function adoptSession(
  candidate: StagedCandidate,
  canonicalRoot: string,
  inputs: ExecutorInputs,
): Promise<void> {
  const active = inputs.supervisor.snapshot().active;
  if (active === undefined || !samePair(active.ref, candidate.ref)) {
    throw new Error('the committed candidate is not the active session');
  }
  const document = { webContentsId: 1, navigationId: candidate.ref.generation };
  const httpBound = inputs.httpBindings.bind({
    role: 'editor',
    host: 'project',
    sessionRef: candidate.ref,
  });
  const clientBound = inputs.sessionClients.bind({
    role: 'editor',
    document,
    sessionRef: candidate.ref,
  });
  if (httpBound.kind !== 'bound' || clientBound.kind !== 'bound') {
    throw new Error('the session editor binding could not be installed');
  }
  const devServerPort = runPortOf(candidate);
  const lease = inputs.listener.grantProjectLease({
    projectKey: active.projectKey,
    upstream: { host: '127.0.0.1', port: devServerPort },
  });
  inputs.grantTables.set(pairKey(candidate.ref), await createGrantTable(canonicalRoot));
  const run = candidateRun(candidate.ref);
  if (run !== null) {
    run.subscribe((event) => {
      const wire: SseEvent =
        event.type === 'invalidation'
          ? { type: 'invalidation', families: [...event.families], revision: event.revision }
          : { type: 'diagnostic', level: event.level, message: event.message };
      const publication = ssePublication({ session: candidate.ref, event: wire });
      if (publication !== null) inputs.hub.publish(publication);
    });
  }
  inputs.seatStore.adopt({
    ref: candidate.ref,
    projectKey: active.projectKey,
    run: run ?? neverSpawnedRun(),
    devServerPort,
    lease,
    fence: createEditFence(),
    editorCapability: httpBound.capability,
    document,
    clientCapability: clientBound.capability,
  });
}

/** The candidate's dev-server port, from the composition's bookkeeping — never the run's to disclose. */
function runPortOf(candidate: StagedCandidate): number {
  const run = candidateRun(candidate.ref);
  return run !== null ? runPort(run) : -1;
}

/** A run that was never spawned — the seat's stand-in on a composition defect (never silently editable). */
function neverSpawnedRun(): ProjectRun {
  const failure = new Error('the session run was never registered');
  const ready = Promise.reject(failure);
  ready.catch(() => {});
  const closed = Promise.resolve({
    reason: 'cancelled',
    outcome: 'complete',
    failures: [],
    accounting: {
      workerReportReceived: false,
      workerCleanupComplete: true,
      workerReaped: false,
      managedAstroReaped: false,
      probesSettled: true,
      killEscalations: [],
    },
  } as const);
  return {
    ready,
    inspect: () => Promise.reject(failure),
    subscribe: () => () => {},
    stop: () => closed,
    closed,
  };
}

/** Runs one fence to its terminal drained verdict — `null` when it failed (§4 step 3's abort). */
async function drainCleanly(fence: EditFence): Promise<EditDrain | null> {
  const started = fence.fence();
  if (started.kind !== 'fenced') return null;
  const report = await started.drain.outcome;
  return report.kind === 'drained' ? started.drain : null;
}

/** The lifecycle result envelope — the target pair plus the snapshot after the transition (ADR-0006 §7). */
function activationResult(
  requestId: string,
  ref: SessionRef,
  projectKey: ProjectKey,
  inputs: ExecutorInputs,
): ResponseEnvelope {
  return {
    protocolVersion: 1,
    requestId,
    session: ref,
    result: {
      kind: 'activation',
      target: { session: ref, projectKey },
      snapshot: inputs.supervisor.snapshot(),
    },
  };
}

function notFoundProject(): PublicError {
  return {
    code: 'resource-not-found',
    message: 'the requested resource does not exist',
    retryable: false,
    details: { what: 'project' },
  };
}

function concurrentActivation(): PublicError {
  return {
    code: 'concurrent-activation',
    message: 'another activation attempt is already in flight',
    retryable: true,
  };
}

function staleSession(): PublicError {
  return {
    code: 'stale-session',
    message: 'the request carries a session that is not the current one',
    retryable: false,
  };
}

/** The closed catch-all — the honest answer for a command this host does not compose. */
function notComposed(): PublicError {
  return {
    code: 'internal-error',
    message: 'the request could not be completed',
    retryable: false,
  };
}

/** Field-wise pair equality — the codebase idiom. */
function samePair(a: SessionRef, b: SessionRef | undefined): boolean {
  return b !== undefined && a.runtimeEpoch === b.runtimeEpoch && a.generation === b.generation;
}

function pairKey(ref: SessionRef): string {
  return `${ref.runtimeEpoch}#${ref.generation}`;
}
