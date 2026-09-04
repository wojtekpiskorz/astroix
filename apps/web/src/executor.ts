import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EditResult,
  ProjectKey,
  PublicError,
  RequestEnvelope,
  ResponseEnvelope,
  SessionRef,
  SseEvent,
  WritePlan,
} from '@wojciechpiskorz/astroix-protocol';
import type { ClientBindings } from '@wojciechpiskorz/astroix-runtime/api/http';
import { pagedProjectList } from '@wojciechpiskorz/astroix-runtime/api/pagination';
import type { DocumentAuthority } from '@wojciechpiskorz/astroix-runtime/client-authority';
import {
  spawnWriteExecutor,
  type WriteExecutorHandle,
} from '@wojciechpiskorz/astroix-runtime/edit-authority/executor';
import {
  createGrantTable,
  type GrantTable,
} from '@wojciechpiskorz/astroix-runtime/edit-authority/grants';
import { planEdit } from '@wojciechpiskorz/astroix-runtime/edit-authority/planning';
import { currentRuntimePin } from '@wojciechpiskorz/astroix-runtime/kernel-lease';
import type { OriginLease, OriginListener } from '@wojciechpiskorz/astroix-runtime/origin';
import type {
  ProjectRun,
  WorkerInspectionRequest,
} from '@wojciechpiskorz/astroix-runtime/project-runtime';
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
 * the coordinator revoked the old one; a settled deactivation also
 * informs the supervisor's revoke seam (#331's law, wired #411) so the
 * active entry clears cleanly — never the bogus crash the outgoing
 * run's late close would otherwise record; `inspect` dispatches the
 * typed families onto the active run. The transition's last step (§4
 * step 6)
 * observes the ADOPTION as the completion: when it fails after the
 * commit linearized, the F7 aftermath owns the convergence (#333's
 * ruling) — the granted candidate's authority dies through F6's ordered
 * revocation pass, its run is reaped, the failed no-active state is
 * reported — never a stranded session behind a live project host.
 *
 * One family is deliberately NOT composed here, and answers the
 * closed catch-all rather than a lie:
 * - none today: `apply-edit` IS composed (#253, J3 — the Content
 *   vertical's write lane is its first browser flow), over the landed
 *   D4 grant table + planning boundary and the real D5 write-executor
 *   child (lazy-forked at the session's first edit, lifetime-held
 *   edit-writer lease over the injected private state directory),
 *   submitted through the seat's F5 edit fence — the serialized
 *   server-side queue every transition drains.
 *
 * The content inspection is the write loop's discovery vehicle (#253):
 * for the active session the composition enriches each file-backed
 * entry with the server-issued opaque grant (D4 `issue` over the
 * project's OWN served path + revision — ADR-0006 §6 "the server
 * issues grants from its own Content discovery") and the file's raw
 * text (the byte-exact serializer's anchor, the frozen raw-truth
 * contract's continuation). Editor-safety is by construction in this
 * host: the only project-host document ever bound is the editor's (the
 * document surface binds exactly one client — the diagnostic-role
 * documents the desktop host adds will re-derive enrichment from their
 * binding's role there, where the role is in scope).
 *
 * The `styles` family IS composed (#370): its protocol envelope carries
 * the observed canvas pathname, and the executor resolves it to the
 * active route's component through the run's control-plane-only
 * `route-selection` dispatch before handing the worker its
 * `routeComponent`. The component is this plane's own currency — the
 * resolution result never enters a response envelope (the no-
 * disclosure law), and the desktop composition (H7's shared executor)
 * inherits the family identically. The family's payload is also the
 * CSS write loop's discovery vehicle (#250, I2): each named file is
 * enriched with the server-issued opaque css grant (D4 `issue` over
 * the bytes this composition read) plus the file's raw text — the
 * splice planner's byte anchor, the content family's own discipline.
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
  /**
   * The write executors this composition forked, by pair key (#253, J3):
   * lazy — the session's executor is forked at its FIRST accepted edit
   * (nothing before then holds the app-global edit-writer lease), and
   * stopped at the seat's teardown (the revocation pass's eviction). A
   * handle whose child EXITS is also evicted the moment the exit is
   * observed (#391): a crashed executor never wedges the session's
   * writes — the next accepted edit lazily respawns a fresh disposable
   * child over the lease the exit released.
   */
  readonly writeExecutors: Map<string, WriteExecutorHandle>;
  /**
   * The per-edit outcome await's bound (#391): the F5 fence's drain
   * deadline law (ADR-0006 §4 step 2's "up to 5 seconds"), restated at
   * the composition — the runtime's `DRAIN_DEADLINE_MS` is not exported
   * through the fence's package surface, and the ADR is the shared
   * authority both constants cite. Injectable so the focused legs bound
   * it tightly; production never overrides it.
   */
  readonly editOutcomeDeadlineMs?: number;
  /**
   * The private state directory the write executor's kernel lease files
   * live under (the web host's isolation story: an injected directory
   * beside the isolated registry, never a production `userData` root).
   */
  readonly privateStateDirectory: string;
  /** The edit results' monotonic per-session revision counters (by pair key). */
  readonly editRevisions: Map<string, number>;
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

/** The write executor's terminal outcome, through the handle's own inference (the D5 closed surface). */
type ExecutorOutcome = Awaited<ReturnType<WriteExecutorHandle['execute']>>;

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
      return applyEdit(envelope, inputs);
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

/**
 * The settled activation transition (ADR-0006 §4): stage, drain, receipt, commit, adopt.
 *
 * Two switch-discipline laws hold at the top (#411–#413):
 * - Same-project re-activation is the idempotent no-op (#413): the
 *   requested postcondition — this project active — already holds, so
 *   the answer is the CURRENT session's activation envelope, never a
 *   staged second plane for the same canonical root (two concurrent
 *   `astro dev` children over one root crash both planes — the zombie
 *   the defect recorded). A fresh generation onto the same root remains
 *   the explicit deactivate-then-activate the launcher already drives;
 *   no fresh-generation "reload" is composed, and none is pretended.
 * - The candidate slate resets only for the ADMITTED attempt, after
 *   `begin`'s refusal gate (#412): a refused concurrent activation
 *   touches no bookkeeping, so the in-flight attempt's remembered run
 *   survives and the winner's adoption is whole.
 */
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
  // The idempotent no-op reads the SUPERVISOR's active truth (#413), not
  // the seat: a pair that committed but is still mid-adoption is already
  // the active session, and staging a same-root candidate beside it is
  // exactly the two-plane crash the guard exists to refuse.
  const activeNow = inputs.supervisor.snapshot().active;
  if (activeNow !== undefined && activeNow.projectKey === projectKey) {
    return activationResult(envelope.requestId, activeNow.ref, projectKey, inputs);
  }
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
  // The admitted attempt's slate reset (#412): every OTHER pair's
  // bookkeeping dies here — a failed attempt's stragglers never
  // accumulate — while the pair this attempt just reserved inside
  // `begin` survives untouched.
  inputs.candidates.clearExcept(begun.attempt.ref);
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
  // The deactivation-side inform (#411, wiring #331's law over #335's
  // seam): the coordinator's transition settled — authority revoked,
  // the outgoing stop initiated — so the supervisor's active entry
  // empties NOW, without a failure, strictly before the stopped run's
  // close can settle. Without it the entry survives until that late
  // close, where the crash observer records a bogus `crash` failure and
  // poisons every later activation envelope. A refusal (no active
  // session — someone else's clear already won the race) is history,
  // never an error: the linearization this informs already happened.
  await inputs.supervisor.revoke('deactivation');
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

/**
 * The typed inspection dispatch onto the active run — three families map
 * 1:1; `styles` carries the observed canvas pathname (#370): the
 * executor resolves it to the route's component through the run's
 * control-plane-only `route-selection` dispatch, then issues the
 * worker's `routeComponent` request. The resolution is a two-step
 * mapping, and each step's refusal is its own honest answer: a styles
 * request without a selection is malformed (the additive envelope
 * parses, but the inspection cannot be served), an unresolvable route
 * is a 404, and a rejected dispatch is the closed catch-all.
 */
async function inspect(
  envelope: RequestEnvelope,
  inputs: ExecutorInputs,
): Promise<ResponseEnvelope | PublicError> {
  if (envelope.command.kind !== 'inspect') throw new Error('dispatch defect');
  const seat = inputs.seatStore.active();
  if (seat === null || !samePair(seat.ref, envelope.session)) return staleSession();
  const request = envelope.command.request;
  try {
    // The styles family carries the observed canvas pathname (#370):
    // the additive envelope also parses WITHOUT one, but the inspection
    // cannot be served without a selection — the same malformed-shape
    // refusal the admission layer would answer had the field been
    // required. The selection maps through the run's control-plane-only
    // resolution onto the worker's `routeComponent` request; the other
    // three families dispatch 1:1.
    let dispatched: WorkerInspectionRequest;
    if (request.kind === 'styles') {
      const { route } = request;
      if (route === undefined) return stylesRouteRequired();
      const mapped = await stylesRequestFor(seat, route);
      if (mapped === null) return notFoundRoute();
      dispatched = mapped;
    } else {
      dispatched = request;
    }
    const result = await seat.run.inspect(dispatched);
    // The wire belt: a route-selection result can never ride an
    // envelope — the protocol's closed inspection union refuses the kind
    // and the component it carries (the no-disclosure law, enforced here
    // rather than trusted).
    if (result.kind === 'route-selection') return notComposed();
    // The write loop's discovery enrichment (#253, J3): the content
    // family's payload gains, per file-backed entry, the server-issued
    // opaque grant at the inspected revision plus the file's raw text.
    // Additive by construction (the frozen inspection contracts pin the
    // fields they froze; the served payload already carries revision
    // and issues beyond them); best-effort per entry — an enrichment
    // that cannot prove the disk still matches the inspected revision
    // serves the entry UN-enriched (read-only truth), never a stale
    // grant.
    const payload =
      request.kind === 'content' && result.kind === 'content'
        ? await enrichContentPayload(seat, inputs, result.payload)
        : request.kind === 'styles' && result.kind === 'styles'
          ? await enrichStylesPayload(seat, inputs, result.payload)
          : result.payload;
    return {
      protocolVersion: 1,
      requestId: envelope.requestId,
      session: seat.ref,
      result: { kind: 'inspection', result: { ...result, payload } },
    };
  } catch {
    return notComposed();
  }
}

/**
 * The write enrichments' shared admission: the session's grant table
 * plus the project's canonical root — `null` when either truth is
 * absent (the caller's un-enriched pass-through, never a heuristic
 * grant). The root is the composition's own registry lookup over the
 * ACTIVE session's project — never browser-supplied, never a coerced
 * miss.
 */
function enrichmentAuthority(
  seat: SessionSeat,
  inputs: ExecutorInputs,
): { readonly table: GrantTable; readonly root: string } | null {
  const table = inputs.grantTables.get(pairKey(seat.ref));
  if (table === undefined) return null;
  const root = inputs.registry
    .snapshot()
    .records.find((entry) => entry.projectKey === seat.projectKey)?.canonicalRoot;
  if (root === undefined) return null;
  return { table, root };
}

/**
 * Enriches one content-inspection payload with the write facts (#253):
 * per file-backed entry whose bytes still hash to the inspected
 * revision, the D4 grant issued from THOSE facts (the project's own
 * served path and revision — never a client-selected resource) and the
 * raw text itself. Issuance supersedes the session's previous grant for
 * the same target (the table's own law), so the freshest inspection a
 * document binds always carries the live grant; a stale one dies as
 * `unknown-grant` at the next write, exactly the closed-table refusal.
 */
async function enrichContentPayload(
  seat: SessionSeat,
  inputs: ExecutorInputs,
  payload: unknown,
): Promise<unknown> {
  const authority = enrichmentAuthority(seat, inputs);
  const record = payload as { collections?: unknown };
  if (authority === null || !Array.isArray(record?.collections)) return payload;
  const { table, root } = authority;
  const collections = await Promise.all(
    record.collections.map(async (collection: unknown) => {
      const named = collection as { entries?: unknown };
      if (!Array.isArray(named?.entries)) return collection;
      const entries = await Promise.all(
        named.entries.map((entry: unknown) => enrichEntry(entry, root, table, seat.ref)),
      );
      return { ...(collection as object), entries };
    }),
  );
  return { ...(payload as object), collections };
}

/** Enriches one entry record — verbatim when the facts cannot be proven. */
async function enrichEntry(
  entry: unknown,
  root: string,
  table: GrantTable,
  session: SessionRef,
): Promise<unknown> {
  const record = entry as { filePath?: unknown; revision?: unknown };
  if (typeof record?.filePath !== 'string' || typeof record?.revision !== 'string') return entry;
  let bytes: Buffer;
  try {
    bytes = await readFile(join(root, record.filePath));
  } catch {
    return entry;
  }
  // The freshness proof: the disk's current bytes ARE the inspected
  // revision — anything else serves the entry un-enriched.
  if (sha256Of(bytes) !== record.revision) return entry;
  const granted = await table.issue(
    {
      discovery: 'existing-text',
      kind: 'content',
      path: record.filePath,
      revision: record.revision,
    },
    session,
  );
  if (!granted.ok) return entry;
  return { ...(entry as object), grant: granted.grant, raw: bytes.toString('utf8') };
}

/** SHA-256 hex over bytes — the freshness proof's own oracle. */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Enriches one styles-inspection payload with the write facts (#250,
 * I2 — the CSS vertical's discovery vehicle, J3's content discipline
 * applied to the styles family): per file the converged records name,
 * the D4 css grant issued over the bytes this enrichment READ (the
 * project's own served path and its exact current digest — never a
 * client-selected resource) plus the file's raw text (the splice
 * planner's byte anchor). Additive by construction (the payload a
 * pre-write client binds keeps parsing without it); best-effort per
 * file — a file whose records do not fit the read bytes serves
 * UN-enriched (read-only truth), never a grant over bytes the records
 * were not indexed over. Issuance supersedes the session's previous
 * grant for the same target (the table's own law), so the freshest
 * inspection a document binds always carries the live grant — and
 * issuance order across files is NOT load-bearing (each target
 * supersedes only its own previous grant), so the per-file
 * enrichments parallelize exactly like the content family's, with
 * `Promise.all` keeping the served `writeFacts` order deterministic.
 */
async function enrichStylesPayload(
  seat: SessionSeat,
  inputs: ExecutorInputs,
  payload: unknown,
): Promise<unknown> {
  const authority = enrichmentAuthority(seat, inputs);
  const record = payload as { records?: unknown };
  if (authority === null || !Array.isArray(record?.records)) return payload;
  const { table, root } = authority;
  // The bound array keeps the guard's narrowing inside the parallel map —
  // a property narrowing never survives into a closure on its own.
  const records: readonly unknown[] = record.records;
  const files = new Set<string>();
  for (const entry of records) {
    const file = (entry as { file?: unknown })?.file;
    if (typeof file === 'string' && file.length > 0) files.add(file);
  }
  const writeFacts = (
    await Promise.all([...files].map((file) => enrichStylesFile(seat, root, table, file, records)))
  ).filter((fact) => fact !== null);
  if (writeFacts.length === 0) return payload;
  return { ...(payload as object), writeFacts };
}

/**
 * One file's write fact — `null` when the facts cannot be proven: the
 * file unreadable, or any record of it carrying a range beyond the
 * bytes actually read (the indexed truth and the disk drifted apart —
 * the read-only answer, never a grant over incoherent anchors).
 */
async function enrichStylesFile(
  seat: SessionSeat,
  root: string,
  table: GrantTable,
  file: string,
  records: readonly unknown[],
): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(root, file));
  } catch {
    return null;
  }
  const raw = bytes.toString('utf8');
  // The coherence gate: every record of this file must fit the bytes
  // the grant would bind — the ranges are string indices over exactly
  // these contents, and one that does not fit is proof the indexed
  // truth is not this disk's.
  const fits = records.every((entry) => {
    const candidate = entry as { file?: unknown; range?: { end?: unknown } };
    if (candidate?.file !== file) return true;
    return typeof candidate.range?.end === 'number' && candidate.range.end <= raw.length;
  });
  if (!fits) return null;
  const granted = await table.issue(
    {
      discovery: 'existing-text',
      kind: 'css',
      path: file,
      revision: sha256Of(bytes),
    },
    seat.ref,
  );
  if (!granted.ok) return null;
  return { file, grant: granted.grant, raw };
}

/**
 * The grant-bound edit execution (#253, J3; ADR-0006 §6): the wire plan
 * through the D4 planning boundary (grant table + echo equality + the
 * world's revision contract), the accepted domain plan through the
 * seat's F5 fence (the serialized queue every transition drains), onto
 * the real D5 write-executor child. The outcome mapping is the closed
 * public vocabulary: conflicts hand back the disk truth's SHA (the
 * frozen conflict contract's sanitized continuation), grant failures
 * name their policy category, and the `unknown`/`failed` outcomes stay
 * the honest catch-all — the client's post-commit uncertainty state is
 * its convergence, never a guess here. The outcome AWAIT is bounded by
 * the fence's drain-deadline law and the hung child disposed (#391):
 * the response never hangs past the bound, and the disposable executor
 * never wedges the session's later writes.
 */
async function applyEdit(
  envelope: RequestEnvelope,
  inputs: ExecutorInputs,
): Promise<ResponseEnvelope | PublicError> {
  if (envelope.command.kind !== 'apply-edit') throw new Error('dispatch defect');
  const seat = inputs.seatStore.active();
  if (seat === null || !samePair(seat.ref, envelope.session)) return staleSession();
  const table = inputs.grantTables.get(pairKey(seat.ref));
  if (table === undefined) return notComposed();
  const wire: WritePlan = envelope.command.plan;
  const planned = await planEdit(table, { session: seat.ref, plan: wire });
  if (!planned.ok) {
    return planFailure(planned).code === 'revision-conflict'
      ? conflictWithCurrentSha(inputs, seat, wire.grant.displayPath)
      : planFailure(planned);
  }
  const executor = await writeExecutorFor(seat, inputs);
  if (executor === null) return notComposed();
  // The raw outcome rides the closure beside the fence's classified one
  // — the drain's vocabulary is the transition's; the edit result needs
  // the committed revision the classification folds away.
  const captured: { outcome: ExecutorOutcome | null } = { outcome: null };
  const submission = seat.fence.submit({
    key: `edit-${wire.grant.token.slice(0, 12)}`,
    execute: async () => {
      captured.outcome = await executor.execute(planned.plan);
      return captured.outcome;
    },
  });
  if (submission.kind === 'refused') {
    // Admission closed: a transition is draining this session's edits —
    // the retryable answer, never a silent drop.
    return concurrentEditDrain();
  }
  // The outcome await is BOUNDED by the fence's own deadline law (#391):
  // the per-op promise settles only at the child's terminality, so a
  // hung write executor would otherwise hang this response past every
  // bound. A timeout is the living sibling of the `unknown` outcome —
  // the child is alive but unresponsive, the rename may or may not
  // land — and the fence keeps tracking the accepted work either way
  // (its no-silent-work law); the answer maps through the bounded-drain
  // vocabulary's failure fold, the same closed catch-all `unknown` gets.
  const awaited = await awaitEditOutcome(
    submission.outcome,
    inputs.editOutcomeDeadlineMs ?? EDIT_OUTCOME_DEADLINE_MS,
  );
  const outcome: ExecutorOutcome | null = captured.outcome;
  if (outcome === null) {
    // A hung child is also DISPOSED here — but only on the timeout
    // verdict: a settled-but-null capture is a rejecting dispatch (the
    // fenced admission of a stopped or exited handle), where the
    // handle's own exit eviction is the recovery and a kill would fire
    // on a possibly-healthy, merely-fenced executor.
    if (awaited === 'timed-out') await disposeHungExecutor(inputs, seat.ref, executor);
    return notComposed();
  }
  return editOutcomeResponse(envelope, seat, inputs, table, wire.grant, outcome);
}

/**
 * The landed outcome's response mapping — the closed public vocabulary
 * applied to one terminal executor outcome: the commit mints its
 * follow-on grant (bound to the LANDED bytes' revision, through the
 * same table that authorized the write), the revision-contract
 * rejections hand back the disk truth's SHA, and everything else stays
 * the honest catch-all.
 */
async function editOutcomeResponse(
  envelope: RequestEnvelope,
  seat: SessionSeat,
  inputs: ExecutorInputs,
  table: GrantTable,
  grant: WritePlan['grant'],
  outcome: ExecutorOutcome,
): Promise<ResponseEnvelope | PublicError> {
  if (outcome.type === 'committed') {
    // The follow-on grant binds the LANDED bytes' revision (ADR-0006
    // §6), minted through the same table that authorized the write —
    // and the KIND the write's grant carried (#250): a css splice
    // renews css authority, a content replacement renews content, so
    // the continued edit never needs a wrong-kind grant.
    const next = await table.issue(
      {
        discovery: 'existing-text',
        kind: grant.kind,
        path: grant.displayPath,
        revision: outcome.revision,
      },
      seat.ref,
    );
    const result: EditResult = {
      revision: nextEditRevision(inputs, seat.ref),
      ...(next.ok ? { nextGrant: next.grant } : {}),
    };
    return {
      protocolVersion: 1,
      requestId: envelope.requestId,
      session: seat.ref,
      result: { kind: 'edit', result },
    };
  }
  if (outcome.type === 'rejected') {
    return writeRejection(outcome).code === 'revision-conflict'
      ? conflictWithCurrentSha(inputs, seat, grant.displayPath)
      : writeRejection(outcome);
  }
  // failed | unknown: no bytes were proven landed by this response —
  // the closed catch-all keeps the client's convergence honest.
  return notComposed();
}

/**
 * The session's write executor — forked lazily at the FIRST accepted
 * edit and retained for the seat's lifetime. The kernel edit-writer
 * lease is app-global and lifetime-held (D3/D5): a predecessor must
 * have exited (the revocation pass stops the old seat's executor
 * before the new session adopts), and a boot that cannot take the
 * lease fails the write closed rather than bypassing the authority.
 * Every retention point also tracks the handle's exit (#391): a
 * crashed child is evicted from the table the moment its exit is
 * observed, so the next accepted edit respawns instead of failing
 * closed against a dead handle until some session switch.
 */
async function writeExecutorFor(
  seat: SessionSeat,
  inputs: ExecutorInputs,
): Promise<WriteExecutorHandle | null> {
  const key = pairKey(seat.ref);
  const existing = inputs.writeExecutors.get(key);
  if (existing !== undefined) {
    trackExecutorExit(inputs, key, existing);
    return existing;
  }
  const root = inputs.registry
    .snapshot()
    .records.find((entry) => entry.projectKey === seat.projectKey)?.canonicalRoot;
  if (root === undefined) return null;
  const handle = spawnWriteExecutor({
    privateStateDirectory: inputs.privateStateDirectory,
    canonicalRoot: root,
    session: seat.ref,
    qualifiedRuntime: currentRuntimePin(),
  });
  inputs.writeExecutors.set(key, handle);
  trackExecutorExit(inputs, key, handle);
  try {
    await handle.ready;
  } catch {
    // identity-guarded: a concurrent first-write may have replaced this
    // entry — deleting unconditionally would orphan the winner's live
    // handle (untracked for close, lease-contentious for respawns)
    if (inputs.writeExecutors.get(key) === handle) inputs.writeExecutors.delete(key);
    await handle.kill().catch(() => {});
    return null;
  }
  return handle;
}

/**
 * The exit-listener memo — one listener per handle, never per read.
 * Handle-identity bookkeeping, not composition state (the no-module-
 * globals law is about composition state; this guard owns no lifetime
 * of its own — the WeakSet frees a dead handle the moment nothing else
 * holds it), so a cached read may re-track freely.
 */
const exitTracked = new WeakSet<WriteExecutorHandle>();

/**
 * The crashed-executor eviction (#391): one exit listener per handle,
 * attached at every retention point — a spawned handle and a harness-
 * seeded one are tracked alike at their first touch. The identity
 * guard keeps a predecessor's late exit from evicting its successor:
 * eviction removes exactly the handle that exited, never whatever the
 * pair key holds now.
 */
function trackExecutorExit(inputs: ExecutorInputs, key: string, handle: WriteExecutorHandle): void {
  if (exitTracked.has(handle)) return;
  exitTracked.add(handle);
  void handle.exited
    .then(() => {
      if (inputs.writeExecutors.get(key) === handle) inputs.writeExecutors.delete(key);
    })
    .catch(() => {});
}

/**
 * Disposes one hung write executor (#391): the eviction is
 * identity-guarded and the kill's own settlement — the exit the
 * handle observes — is awaited before the caller answers, so the
 * app-global edit-writer lease is released and the next accepted
 * edit's lazy respawn does not race a dying predecessor's lease. The
 * D5 executor is disposable by charter, and SIGKILL is its documented
 * force path (the one F6's forced preparation takes): unsettled work
 * resolves `unknown`, which is exactly the uncertainty the timed-out
 * response already reported.
 */
async function disposeHungExecutor(
  inputs: ExecutorInputs,
  ref: SessionRef,
  handle: WriteExecutorHandle,
): Promise<void> {
  const key = pairKey(ref);
  if (inputs.writeExecutors.get(key) === handle) inputs.writeExecutors.delete(key);
  await handle.kill().catch(() => {});
}

/** The outcome await's default bound — the F5 drain deadline's law, restated (see {@link ExecutorInputs.editOutcomeDeadlineMs}). */
const EDIT_OUTCOME_DEADLINE_MS = 5000;

/**
 * The bounded outcome await (#391): races the fence's per-operation
 * promise against the deadline, never against the child's terminality.
 * The per-op promise resolves, never rejects (the fence settles a
 * rejecting thunk as an honest failure) — the rejection belt below
 * only preserves that contract if the fence surface itself drifts.
 */
function awaitEditOutcome(
  outcome: Promise<unknown>,
  deadlineMs: number,
): Promise<'settled' | 'timed-out'> {
  return new Promise((resolve, reject) => {
    const disarm = setTimeout(() => resolve('timed-out'), deadlineMs);
    outcome.then(
      () => {
        clearTimeout(disarm);
        resolve('settled');
      },
      (error: unknown) => {
        clearTimeout(disarm);
        reject(error);
      },
    );
  });
}

/** Stops a session's forked write executor, if any — the seat teardown's step. */
export async function stopWriteExecutor(inputs: ExecutorInputs, ref: SessionRef): Promise<void> {
  const handle = inputs.writeExecutors.get(pairKey(ref));
  if (handle === undefined) return;
  inputs.writeExecutors.delete(pairKey(ref));
  await handle.stop().catch(() => {});
}

/**
 * Stops every run this composition owns — the seated session's run and
 * every staged candidate's (#365's addendum, #391): the composition's
 * close previously awaited only the SEATED run, so an unseated
 * candidate's managed dev server outlived teardown as an orphaned
 * child. Each stop is the plane supervisor's own ordered graceful stop
 * — internally bounded (its term/kill escalation), so the parallel
 * pass converges inside one stop window — and the seated run may also
 * be a remembered candidate: one run, one stop.
 */
export async function stopOwnedRuns(
  seat: SessionSeat | null,
  candidates: CandidateStore,
): Promise<void> {
  const runs = new Set<ProjectRun>(seat === null ? [] : [seat.run]);
  for (const run of candidates.runs()) runs.add(run);
  await Promise.all([...runs].map((run) => run.stop().catch(() => {})));
}

/** The edit result's monotonic per-session revision counter — the composition's own lift. */
function nextEditRevision(inputs: ExecutorInputs, ref: SessionRef): number {
  const key = pairKey(ref);
  const next = (inputs.editRevisions.get(key) ?? 0) + 1;
  inputs.editRevisions.set(key, next);
  return next;
}

/**
 * The failure classes both rejection mappings fold onto: the constant
 * grant/malformed/refusal answers, plus the two classes the caller
 * decorates (the conflict gains the disk-truth SHA; the absent answer
 * stands alone).
 */
type FailureClass = 'conflict' | 'absent';

/** The planning-boundary failure table — one row per closed failure code. */
const PLAN_FAILURES: Readonly<Record<string, PublicError | FailureClass>> = {
  'unknown-grant': grantRejected('revoked'),
  revoked: grantRejected('revoked'),
  'cross-session': grantRejected('cross-session'),
  'wrong-kind': grantRejected('kind-mismatch'),
  'operation-not-allowed': grantRejected('operation-not-allowed'),
  'hard-linked-target': grantRejected('hard-link'),
  'outside-root': grantRejected('external-symlink'),
  'parent-outside-root': grantRejected('external-symlink'),
  'changed-baseline': 'conflict',
  'target-exists': 'conflict',
  'target-absent': 'absent',
  'parent-absent': 'absent',
  'not-a-file': 'absent',
  'parent-not-directory': 'absent',
  'target-moved': 'absent',
  'invalid-plan': malformedPlan(),
  'claim-mismatch': malformedPlan(),
  // The style planner's range proof: a splice planned against bytes
  // other than the world's verified contents is incoherent with the
  // revision contract — the conflict class (the caller hands back the
  // disk SHA), never the catch-all's post-commit uncertainty.
  'range-outside-baseline': 'conflict',
};

/** The executor-rejection table — one row per closed rejection code. */
const WRITE_REJECTIONS: Readonly<Record<string, PublicError | FailureClass>> = {
  'cross-session': grantRejected('cross-session'),
  'wrong-root': grantRejected('external-symlink'),
  'operation-not-allowed': grantRejected('operation-not-allowed'),
  'operation-target-mismatch': grantRejected('operation-not-allowed'),
  'hard-linked-target': grantRejected('hard-link'),
  'changed-baseline': 'conflict',
  'target-exists': 'conflict',
  'target-absent': 'absent',
  'parent-absent': 'absent',
  'not-a-file': 'absent',
  'parent-not-directory': 'absent',
  'target-moved': 'absent',
  // Final validation repeats the range proof over the verified bytes —
  // the same conflict class, with the SHA handback.
  'range-outside-baseline': 'conflict',
  // Admission-time, never world-time: the fenced executor never
  // accepted the work, so nothing landed — the retryable drain answer,
  // never the catch-all's post-commit uncertainty.
  fenced: concurrentEditDrain(),
  'malformed-plan': malformedPlan(),
};

/** Reads one failure table row — the closed catch-all for unknown codes. */
function tableAnswer(table: Readonly<Record<string, PublicError | FailureClass>>, code: string) {
  return table[code] ?? notComposed();
}

/** Maps one planning-boundary failure onto the closed public vocabulary. */
function planFailure(failure: { code: string }): PublicError {
  const answer = tableAnswer(PLAN_FAILURES, failure.code);
  return typeof answer === 'string' ? classFailure(answer) : answer;
}

/** Maps one executor rejection onto the closed public vocabulary. */
function writeRejection(outcome: Extract<ExecutorOutcome, { type: 'rejected' }>): PublicError {
  const answer = tableAnswer(WRITE_REJECTIONS, outcome.code);
  return typeof answer === 'string' ? classFailure(answer) : answer;
}

/** The class-fold: the conflict and the absent refusal, never a branch per code. */
function classFailure(failureClass: FailureClass): PublicError {
  return failureClass === 'conflict' ? revisionConflict() : notFoundResource();
}

/**
 * The revision-conflict answer with the target's current SHA attached —
 * the disk-truth handback the client's next attempt serializes against
 * (the frozen conflict contract's sanitized continuation). Best-effort:
 * a target that cannot be re-read answers the bare conflict, never a
 * guess.
 */
async function conflictWithCurrentSha(
  inputs: ExecutorInputs,
  seat: SessionSeat,
  displayPath: string,
): Promise<PublicError> {
  const root = inputs.registry
    .snapshot()
    .records.find((entry) => entry.projectKey === seat.projectKey)?.canonicalRoot;
  if (root === undefined) return revisionConflict();
  try {
    const current = sha256Of(await readFile(join(root, displayPath)));
    return {
      code: 'revision-conflict',
      message: 'the resource no longer matches the expected revision',
      retryable: false,
      details: { currentSha256: current },
    };
  } catch {
    return revisionConflict();
  }
}

/** The bare revision-conflict answer — sanitized, no handback. */
function revisionConflict(): PublicError {
  return {
    code: 'revision-conflict',
    message: 'the resource no longer matches the expected revision',
    retryable: false,
  };
}

function grantRejected(
  reason:
    | 'revoked'
    | 'cross-session'
    | 'kind-mismatch'
    | 'operation-not-allowed'
    | 'hard-link'
    | 'external-symlink',
): PublicError {
  return {
    code: 'grant-rejected',
    message: 'the presented grant was refused without writing',
    retryable: false,
    details: { reason },
  };
}

function malformedPlan(): PublicError {
  return {
    code: 'malformed-request',
    message: 'the write plan does not satisfy the protocol contract',
    retryable: false,
    details: { issue: 'invalid-shape', pointer: 'command.plan' },
  };
}

function notFoundResource(): PublicError {
  return {
    code: 'resource-not-found',
    message: 'the requested resource does not exist',
    retryable: false,
    details: { what: 'resource' },
  };
}

function concurrentEditDrain(): PublicError {
  return {
    code: 'concurrent-activation',
    message: 'a session transition is draining this session\u2019s edits',
    retryable: true,
  };
}

/**
 * Maps the wire-carried selection onto the worker's styles request:
 * resolves the observed pathname through the run, then carries the
 * component into `routeComponent`. `null` is the honest unresolvable
 * answer (the caller's 404); a rejected dispatch propagates (the
 * caller's catch-all) — and the resolution result itself is consumed
 * here, never forwarded: the component stays control-plane currency.
 */
async function stylesRequestFor(
  seat: SessionSeat,
  route: string,
): Promise<WorkerInspectionRequest | null> {
  const resolved = await seat.run.inspect({ kind: 'route-selection', route });
  if (resolved.kind !== 'route-selection') throw new Error('dispatch defect');
  const selection = resolved.payload.selection;
  return selection === null ? null : { kind: 'styles', routeComponent: selection.component };
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

/**
 * The unresolvable styles selection (#370): the observed pathname
 * matches no project page route — a 404 naming the route, never a
 * component, a filesystem fact, or a guess.
 */
function notFoundRoute(): PublicError {
  return {
    code: 'resource-not-found',
    message: 'the requested resource does not exist',
    retryable: false,
    details: { what: 'route' },
  };
}

/**
 * A styles request without its route selection (#370): the envelope is
 * additive (the pre-#370 shape still parses), but the inspection cannot
 * be served without a selection — the same malformed-shape refusal the
 * admission layer would answer had the field been required.
 */
function stylesRouteRequired(): PublicError {
  return {
    code: 'malformed-request',
    message: 'a styles inspection must carry the observed canvas route',
    retryable: false,
    details: { issue: 'invalid-shape', pointer: 'command.request' },
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
