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
import type { DocumentAuthority } from '@wojciechpiskorz/astroix-runtime/client-authority';
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
import type {
  CompletionClientIdentity,
  GrantedCandidateTarget,
  SessionCompletion,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/completion';
import {
  createEditFence,
  type EditDrain,
  type EditFence,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/fence';
import {
  neverGrantedRoutes,
  type RoutesTarget,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/revocation';
import {
  ActivationFailedError,
  type SessionSupervisor,
  type StagedCandidate,
  type SupervisionCloseReport,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/staging';
import type { SseHub } from '@wojciechpiskorz/astroix-runtime/sse';
import { ssePublication } from '@wojciechpiskorz/astroix-runtime/sse';
import { type CandidateStore, pairKey } from './candidates.ts';
import { neverSpawnedRun } from './never-spawned.ts';

/**
 * The command executor of the web host (#240): the composition behind
 * the F2 dispatch's `executeCommand` seam — where the closed browser
 * command set meets the control plane. `list-projects` reads the
 * injected registry through F3's bounded page builder; `activate` and
 * `deactivate` drive the settled transition protocol (ADR-0006 §4) over
 * the landed F4/F5/F6/F7 surfaces — stage privately, drain the old
 * session's fence, mint the one-use receipt, consume it at the commit
 * linearization point, then grant the new origin lease strictly after
 * the coordinator revoked the old one; `inspect` dispatches the typed
 * families onto the active run. The transition's last step (§4 step 6)
 * observes the ADOPTION as the completion: when it fails after the
 * commit linearized, the F7 aftermath owns the convergence (#333's
 * ruling) — the granted candidate's authority dies through F6's ordered
 * revocation pass, its run is reaped, the failed no-active state is
 * reported — never a stranded session behind a live project host.
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

/**
 * What one adoption granted before it failed — the stranded-adoption
 * aftermath's "where applicable" inventory (#333): the F7 candidate
 * revocation addresses exactly what the commit and the failed adoption
 * minted, never a re-read of what is active.
 */
interface AdoptionTrail {
  /** The HTTP-side editor capability, once `bind` answered bound. */
  httpCapability: string | null;
  /** The supervisor-side editor capability, once `bind` answered bound. */
  supervisorCapability: string | null;
  /** The granted origin lease — the route the ordered pass retires. */
  lease: OriginLease | null;
}

/** Everything the executor drives. */
export interface ExecutorInputs {
  readonly registry: ProjectRegistry;
  readonly supervisor: SessionSupervisor;
  readonly coordinator: SwitchCoordinator;
  /** F7's completion (#239): the transition's observed last step and its irreversible failure aftermath. */
  readonly completion: SessionCompletion;
  /**
   * The document authority (#246, H4): the server-side both-truths bind
   * discipline the adoption mints through — the composition declares the
   * authoritative target and observes its navigations; one bind, one
   * grant, two tables in lockstep.
   */
  readonly authority: DocumentAuthority;
  readonly seatStore: SeatStore;
  readonly listener: OriginListener;
  readonly sessionClients: SessionClients;
  readonly httpBindings: ClientBindings;
  readonly grantTables: Map<string, GrantTable>;
  readonly pendingDevPorts: number[];
  readonly freePort: () => Promise<number>;
  readonly hub: SseHub;
  /** The composition-owned candidate bookkeeping — runs and dev-server ports by pair. */
  readonly candidates: CandidateStore;
  /**
   * The Electron host's adoption seam (#362, H7): when present, the
   * transition's host observations are the HOST's (the authoritative
   * window's real main-frame handshake over the private channel); absent,
   * the web host's stand-in holds — the adoption itself is the
   * observation. One seam, two hosts; never a second transition driver.
   */
  readonly host?: HostAdoptionSeam;
}

/**
 * The host's half of one committed transition: the observations F7's
 * completion awaits. The Electron host loads the granted project origin
 * on the authoritative target and reports the observed document; the
 * web host's default implementation (below) adopts the stand-in
 * document synchronously. Each member returns a REJECTED promise when
 * unobserved — F7 treats rejection as `false`, never a failure.
 */
export interface HostAdoptionSeam {
  /**
   * The activation observation (§4 step 6): grant nothing here — the
   * adoption tail (`adoptSessionAtDocument`) is the caller's; this
   * member resolves once the HOST has replaced the top level and
   * observed the new document, and everything it needs to reach that
   * point (the origin lease included) is the composition's.
   */
  mainFrameReady(candidate: StagedCandidate, trail: AdoptionTrail): Promise<void>;
  /** The deactivation observation — the launcher is the host's to show. */
  launcherReady(): Promise<void>;
  /** The quit observation — the close without navigation. */
  targetClosed(): Promise<void>;
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
  inputs.candidates.clear();
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
  // The commit tail answers one way whether it committed, the drain
  // aborted (rollback + resume, §4 step 3 — the old session untouched),
  // or authority was revoked and the grant failed (§4 step 7 —
  // irreversible, F7's aftermath): the snapshot distinguishes them, and
  // it is the answer either way.
  await commitTransition(candidate, projectKey, inputs);
  return activationResult(envelope.requestId, candidate.ref, projectKey, inputs);
}

/**
 * The transition's commit half, then its completion half (§4 steps 5–6):
 * the plain first commit (the first-commit variant, #349 — no old
 * session existed, so no old-side accounting) or the receipt-gated
 * switch, then the adoption observed as the activation completion. A
 * failed adoption after a
 * committed transition is the irreversible post-revocation failure (§4
 * step 7): it converges through the landed F7 aftermath — the granted
 * candidate's authority revoked by F6's ordered pass, its run reaped,
 * the failed no-active state reported — never a stranded session
 * (#333's ruling: direction (a), no supervisor-side reconciliation).
 * F6's own `failed` grant result rides the same completion unchanged
 * (its failed branch runs the report with the revoked accounting and
 * skips the candidate revocation — the candidate was never granted).
 */
async function commitTransition(
  candidate: StagedCandidate,
  projectKey: ProjectKey,
  inputs: ExecutorInputs,
): Promise<void> {
  const oldSeat = inputs.seatStore.active();
  const transition =
    oldSeat === null
      ? await commitFirstActivation(candidate)
      : await commitSwitch(oldSeat, candidate, inputs);
  // `null` is the pre-linearization abort alone: the drain conflict
  // (rollback + resume — §4 step 3, the old session untouched) or the
  // refused preparation — nothing was revoked, so there is no
  // completion and no aftermath to drive.
  if (transition === null) return;
  const trail: AdoptionTrail = { httpCapability: null, supervisorCapability: null, lease: null };
  const client: CompletionClientIdentity =
    oldSeat === null
      ? {
          document: intendedDocument(candidate),
          // The first activation froze no old client: the identity the
          // failed adoption minted is the reported reference (the empty
          // string when it never got that far) — control-plane currency.
          get capability() {
            return trail.supervisorCapability ?? '';
          },
        }
      : { document: oldSeat.document, capability: oldSeat.clientCapability };
  const host: HostAdoptionSeam = inputs.host ?? webHostAdoption(inputs, candidate, trail);
  await inputs.completion.completeReplacement({
    commit: transition,
    observations: {
      mainFrameReady: () => host.mainFrameReady(candidate, trail),
      launcherReady: () => host.launcherReady(),
      targetClosed: () => host.targetClosed(),
    },
    client,
    candidate: grantedCandidateTarget(candidate, projectKey, trail, inputs),
    targetRemains: true,
  });
}

/**
 * The first activation's plain commit — no old session exists, so
 * there is nothing to drain or revoke: the honest first-commit variant
 * (#349), constructed here because the coordinator owns switches alone
 * (there is no receipt to spend when nothing was ever active).
 */
async function commitFirstActivation(
  candidate: StagedCandidate,
): Promise<CommittedTransition | null> {
  try {
    const granted = await candidate.commit();
    // No old session existed, so no revocation pass ran — the variant
    // carries no `revoked` accounting at all, and F7's failure result
    // preserves the first commit's honest marker, never a fabricated
    // report over a pass that could not have run.
    return { kind: 'first-commit', committed: granted.committed };
  } catch {
    // Nothing was revoked (no old session existed), so this refusal is
    // NOT §4 step 7's aftermath shape: F4's attempt machine already
    // ended the attempt, recorded the sanitized failure on the snapshot
    // (`attemptEnded` → `lastFailure` — the answer the envelope
    // carries), and stopped the orphaned candidate run itself. Route it
    // through F7 anyway and the completion would report a post-
    // revocation failure that never happened.
    return null;
  }
}

/** The receipt-gated switch (§4 steps 2–5): drain, mint, consume — the old lease revokes inside the coordinator. */
async function commitSwitch(
  oldSeat: SessionSeat,
  candidate: StagedCandidate,
  inputs: ExecutorInputs,
): Promise<CommittedTransition | null> {
  const drain = await drainCleanly(oldSeat.fence);
  if (drain === null) {
    // A drain conflict aborts the transition: roll the candidate back
    // and resume the untouched old session (§4 step 3) — resume rides
    // the terminal drain, re-opening admission.
    await candidate.rollback('drain-conflict').catch(() => {});
    return null;
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
    return null;
  }
  const result: CommittedTransition = await inputs.coordinator.commit(prepared.receipt, candidate);
  inputs.seatStore.drop(oldSeat.ref);
  // Only the pre-linearization rejection returns with nothing driven
  // (§4 step 5: nothing spent, nothing revoked — the old session was
  // resumed). F6's own `failed` grant result — authority already
  // revoked, the grant then refused — is the irreversible §4 step 7
  // input F7's completion owns the aftermath for (the coordinator's own
  // contract says so): it rides `completeReplacement` unchanged, which
  // reports the failed no-active state over the preserved revoked
  // accounting and correctly skips the candidate revocation (the
  // candidate was never granted).
  return result.kind === 'rejected' ? null : result;
}

/**
 * The web host's §4 step 6 observations: the ADOPTION is the activation
 * observation — it is the composition's own completion step, the thing
 * that makes the committed session reachable (seat, lease, bindings,
 * documents). The navigation-bearing seams have no web-mode observer —
 * the Electron host lanes satisfy them (#246) — so they answer the
 * honest rejected observation: the aftermath records the unobserved
 * launcher as `false` instead of hanging on a navigation that cannot
 * come from the wire.
 */
function webHostAdoption(
  inputs: ExecutorInputs,
  candidate: StagedCandidate,
  trail: AdoptionTrail,
): HostAdoptionSeam {
  const unobserved = (): Promise<void> =>
    Promise.reject(
      new Error('the web host observes no host-side navigation (the Electron host lanes own it)'),
    );
  return {
    mainFrameReady: async () => {
      // The stand-in's declaration and navigation observation (H4's
      // monotonic law): the web host "navigates" its one virtual
      // document to the candidate's generation, then adopts at exactly
      // that document.
      const document = intendedDocument(candidate);
      inputs.authority.declareAuthoritativeTarget(document.webContentsId);
      inputs.authority.documentNavigated(document.webContentsId, document.navigationId);
      await adoptSession(candidate, trail, inputs, document, null);
    },
    launcherReady: unobserved,
    targetClosed: unobserved,
  };
}

/**
 * The granted candidate as the stranded-adoption aftermath sees it: the
 * authority the commit minted (the pair, the project host scope) plus
 * what the failed adoption itself granted — read lazily off the trail,
 * because the aftermath inspects them only after the observation failed.
 */
function grantedCandidateTarget(
  candidate: StagedCandidate,
  projectKey: ProjectKey,
  trail: AdoptionTrail,
  inputs: ExecutorInputs,
): GrantedCandidateTarget {
  return {
    session: candidate.ref,
    host: { host: 'project', projectKey },
    get routes(): RoutesTarget {
      // The adoption died before the lease was granted: the
      // vocabulary's never-granted view (#349) — no route was
      // published, so nothing retires and no socket dies — never a
      // fabricated pass-shaped answer of this composition's own.
      return trail.lease ?? neverGrantedRoutes;
    },
    get clientCapability(): string {
      // The empty capability is the never-minted truth: unbinding and
      // stream-ending an unknown capability are documented no-ops.
      return trail.httpCapability ?? '';
    },
    stopRun: () => reapGrantedRun(candidate, inputs),
  };
}

/**
 * Reaps the granted run and settles the supervisor's crash observation
 * with it: the observer registered on this run's `closed` at the commit,
 * strictly before this reap's own reaction (promise reaction order), so
 * once `closed` settles here the snapshot already reports the failed
 * no-active state — the landed failure-report surface this composition
 * has for a granted session whose adoption died (F7's declared
 * supervisor-side report seam arrives with the Electron host lane).
 */
async function reapGrantedRun(
  candidate: StagedCandidate,
  inputs: ExecutorInputs,
): Promise<SupervisionCloseReport> {
  const run = inputs.candidates.runOf(candidate.ref);
  if (run === null) return await neverSpawnedRun('the session run was never registered').stop();
  const settled = run.closed.then(
    () => undefined,
    () => undefined,
  );
  const report = await run.stop();
  await settled;
  return report;
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
 * Adopts one committed session — the shared adoption tail (one
 * discipline, two hosts): the editor document binding (ONE mint through
 * H4's document authority — both truths in lockstep), the grant table,
 * the origin lease (the caller's when the Electron host pre-granted it
 * so the origin serves before the host loads it; granted here
 * otherwise), the seat, and the worker event lift onto the hub under
 * the exact pair. Each grant records onto the {@link AdoptionTrail} as
 * it lands, so a throw later in the sequence leaves the aftermath the
 * exact partial-grant inventory to revoke.
 */
export async function adoptSession(
  candidate: StagedCandidate,
  trail: AdoptionTrail,
  inputs: ExecutorInputs,
  document: SessionSeat['document'],
  preGrantedLease: OriginLease | null,
): Promise<void> {
  const active = inputs.supervisor.snapshot().active;
  if (active === undefined || !samePair(active.ref, candidate.ref)) {
    throw new Error('the committed candidate is not the active session');
  }
  // The record root is the composition's own lookup over the ACTIVE
  // session's project — never browser-supplied, never a coerced miss.
  const record = inputs.registry
    .snapshot()
    .records.find((entry) => entry.projectKey === active.projectKey);
  if (record === undefined) throw new Error('the committed session has no registry record');
  const canonicalRoot = record.canonicalRoot;
  const bound = inputs.authority.bindEditor({
    document,
    sessionRef: candidate.ref,
    projectKey: active.projectKey,
  });
  if (bound.kind === 'refused') {
    throw new Error(`the session editor binding could not be installed (${bound.reason})`);
  }
  trail.httpCapability = bound.grant.capability;
  trail.supervisorCapability = bound.grant.clientCapability;
  const devServerPort = inputs.candidates.portOf(candidate.ref);
  const lease =
    preGrantedLease ??
    inputs.listener.grantProjectLease({
      projectKey: active.projectKey,
      upstream: { host: '127.0.0.1', port: devServerPort },
    });
  trail.lease = lease;
  inputs.grantTables.set(pairKey(candidate.ref), await createGrantTable(canonicalRoot));
  const run = inputs.candidates.runOf(candidate.ref);
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
    run: run ?? neverSpawnedRun('the session run was never registered'),
    devServerPort,
    lease,
    fence: createEditFence(),
    editorCapability: bound.grant.capability,
    document,
    clientCapability: bound.grant.clientCapability,
  });
}

/** The document the web host binds every adopted editor at — webContents 1, the generation as the navigation. */
function intendedDocument(candidate: StagedCandidate): SessionSeat['document'] {
  return { webContentsId: 1, navigationId: candidate.ref.generation };
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
