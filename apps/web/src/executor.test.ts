import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ProjectKey,
  PublicError,
  RequestEnvelope,
  ResponseEnvelope,
  SessionFailure,
  SessionRef,
  SessionSnapshot,
} from '@wojciechpiskorz/astroix-protocol';
import {
  type ClientBindings,
  createClientBindings,
  createHostCapabilityGrants,
  type HostCapabilityGrants,
} from '@wojciechpiskorz/astroix-runtime/api/http';
import {
  createDocumentAuthority,
  type DocumentAuthority,
} from '@wojciechpiskorz/astroix-runtime/client-authority';
import type { WriteExecutorHandle } from '@wojciechpiskorz/astroix-runtime/edit-authority/executor';
import type { GrantTable } from '@wojciechpiskorz/astroix-runtime/edit-authority/grants';
import {
  type OriginLease,
  OriginLeaseOccupiedError,
  type OriginListener,
} from '@wojciechpiskorz/astroix-runtime/origin';
import type { ProjectRun } from '@wojciechpiskorz/astroix-runtime/project-runtime';
import type { ProjectRegistry } from '@wojciechpiskorz/astroix-runtime/registry';
import {
  createSessionClients,
  type SessionClients,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/clients';
import {
  createSwitchCoordinator,
  type SwitchCoordinator,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/commit';
import {
  type CompletionResult,
  createSessionCompletion,
  type SessionCompletion,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/completion';
import {
  createEditFence,
  DRAIN_DEADLINE_MS,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/fence';
import { FIRST_COMMIT_REVOCATION } from '@wojciechpiskorz/astroix-runtime/session-supervisor/revocation';
import {
  createSessionSupervisor,
  type SessionSupervisor,
  type SupervisionCloseReport,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/staging';
import { createSseHub } from '@wojciechpiskorz/astroix-runtime/sse';
import { describe, expect, it } from 'vitest';
import { createCandidateStore, pairKey } from './candidates.ts';
import {
  electronHostAdoption,
  type HostDocumentIdentity,
  type HostMainFrameHandshake,
  stopOwnedWriteExecutors,
} from './control-plane.ts';
import {
  createExecutor,
  EDIT_OUTCOME_DEADLINE_MS,
  type ExecutorInputs,
  type SeatStore,
  type SessionSeat,
  stopOwnedRuns,
} from './executor.ts';

/**
 * The stranded-adoption convergence legs (#333, the ruling's direction
 * (a)): the executor composition driven over the REAL landed supervisor
 * (F4), switch coordinator (F6), session completion (F7), and the real
 * capability/binding/client tables — the #236–#239 harness idiom — with
 * manual run and lease seams the tests settle by hand. No real timers,
 * no sockets: the only injected failure is the REAL one the edge names,
 * an `adoptSession` throw after a committed transition (a registry
 * record whose root vanished, so the grant-table creation refuses it
 * after the bindings and the lease were already granted).
 *
 * The two shapes the issue requires: the throw path leaves no
 * 404-on-live-host window (the supervisor reports the failed no-active
 * state before the activation answers, and every surface the failed
 * adoption granted is revoked), and the next activation converges
 * instead of dead-locking on the stale active entry (a fresh committed,
 * adopted session — the stranded lease retired strictly before the
 * successor's grant).
 *
 * The #362 leg widens the injected-failure set by ONE member, through
 * the REAL Electron adoption seam (`electronHostAdoption` — the
 * composition's own wiring, never a re-derivation): a host handshake
 * that cannot report the current document throws AFTER the seam's
 * pre-granted lease and BEFORE `adoptSession` records anything of its
 * own — the trail's grant-time record is the only inventory the
 * aftermath gets.
 */

/** Two valid, distinct project keys (26 lowercase-base32 characters, the protocol's shape). */
const PROJECT_A: ProjectKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT_B: ProjectKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';

/** The ordered-event journal — lease grants/revocations and the aftermath's report, in order. */
type Journal = string[];

/** One activation request envelope — the closed command set's launcher-facing member. */
function activate(projectKey: ProjectKey, requestId: string): RequestEnvelope {
  return { protocolVersion: 1, requestId, command: { kind: 'activate', projectKey } };
}

/** Unwraps one activation result or fails the leg — the envelope is the answer, never swallowed. */
function activationOf(response: ResponseEnvelope | PublicError): {
  target: { session: SessionRef };
  snapshot: SessionSnapshot;
} {
  if (!('protocolVersion' in response) || response.result.kind !== 'activation') {
    throw new Error(`expected an activation envelope, received: ${JSON.stringify(response)}`);
  }
  return response.result;
}

/** A boring complete close report — the manual run's every settlement. */
function completeCloseReport(): SupervisionCloseReport {
  return {
    reason: 'cancelled',
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

/** The manual candidate run — readiness immediate, the close settled by the one stop. */
interface ManualRun {
  readonly run: ProjectRun;
  readonly stopCalls: () => number;
}

function manualRun(inspect?: ProjectRun['inspect']): ManualRun {
  let stopCalls = 0;
  let settle: (report: SupervisionCloseReport) => void = () => {};
  const closed = new Promise<SupervisionCloseReport>((resolve) => {
    settle = resolve;
  });
  const run: ProjectRun = {
    ready: Promise.resolve(),
    inspect: inspect ?? (() => Promise.reject(new Error("inspection is not this lane's subject"))),
    subscribe: () => () => {},
    stop: () => {
      stopCalls += 1;
      settle(completeCloseReport());
      return closed;
    },
    closed,
  };
  return { run, stopCalls: () => stopCalls };
}

/** The fake registry — records only; `execute` is nobody's in these legs. */
function fakeRegistry(
  records: ReadonlyArray<{ readonly projectKey: ProjectKey; readonly canonicalRoot: string }>,
): ProjectRegistry {
  return {
    snapshot: () => ({
      status: 'ok',
      records: records.map((record) => ({ ...record, displayName: 'fixture project' })),
      quarantine: null,
    }),
    execute: async () => ({
      ok: false,
      code: 'closed',
      message: 'the fixture registry executes nothing',
    }),
    projectSummaries: async () => ({ ok: true, summaries: [] }),
    close: async () => {},
  };
}

/** The fake listener — leases journaled, never bound to a socket. */
function fakeListener(journal: Journal): OriginListener {
  const listener = {
    port: 0,
    launcherOrigin: 'http://launcher.localhost:0',
    activeLease: null as OriginLease | null,
    grantProjectLease: (input: {
      readonly projectKey: ProjectKey;
      readonly upstream: { readonly host: string; readonly port: number };
    }): OriginLease => {
      // The real listener's one-active-lease law (F1's host router):
      // a second grant while one is live throws `lease-occupied` — the
      // exact blast radius an unretired lease carries into every later
      // activation, pinned here so the legs observe it as the real
      // listener would.
      if (listener.activeLease !== null) throw new OriginLeaseOccupiedError();
      journal.push(`lease:grant:${input.projectKey[0]}`);
      const lease: OriginLease = {
        projectKey: input.projectKey,
        hostname: `${input.projectKey}.localhost`,
        origin: `http://${input.projectKey}.localhost:0`,
        revoked: false,
        revoke: async () => {
          journal.push(`lease:revoke:${input.projectKey[0]}`);
          if (listener.activeLease === lease) listener.activeLease = null;
          return { projectKey: input.projectKey, destroyedSockets: 0, outcome: 'complete' };
        },
      };
      listener.activeLease = lease;
      return lease;
    },
    close: async () => {},
  };
  return listener;
}

/**
 * The refused-grant coordinator stand-in (the #333 review's T1 leg): one
 * activation's grant refuses AFTER the real revocation pass — the exact
 * shape F6's `failed` result documents. The real staged candidate is
 * settled FIRST, the way every real refused grant arrives (F4's machine
 * had already ended the attempt — a cancelled rollback stops the
 * orphaned run and frees the generation reservation), then the REAL
 * coordinator consumes the real receipt over a candidate whose `commit`
 * refuses: the old-side ordered revocation is real, and the `failed`
 * result is the real machinery's.
 */
function refusingGrantCoordinator(real: SwitchCoordinator): SwitchCoordinator {
  return {
    ...real,
    commit: async (receipt, candidate) => {
      await candidate.rollback('cancelled').catch(() => {});
      const refusing = {
        ref: candidate.ref,
        commit: () => Promise.reject(new Error('the grant refused after the revocation')),
        rollback: candidate.rollback.bind(candidate),
      };
      return await real.commit(receipt, refusing);
    },
  };
}

/** The composition under test, wired exactly as the control plane wires it. */
interface Harness {
  readonly supervisor: SessionSupervisor;
  readonly seatStore: SeatStore;
  readonly httpBindings: ClientBindings;
  readonly sessionClients: SessionClients;
  readonly grants: HostCapabilityGrants;
  readonly grantTables: Map<string, GrantTable>;
  readonly journal: Journal;
  readonly reportedFailures: readonly SessionFailure[];
  /** The completion results the executor drops — recorded by the journaling wrapper (#349). */
  readonly completionResults: readonly CompletionResult[];
  /** The manual runs, in activation order. */
  readonly runs: readonly ManualRun[];
  execute(envelope: RequestEnvelope): Promise<ResponseEnvelope | PublicError>;
  close(): Promise<void>;
}

/**
 * Boots the harness: the REAL supervisor/coordinator/completion over the
 * real tables, manual runs, journaled leases. Project A's root exists on
 * disk (adoptions of A succeed); project B's root is a vanished path —
 * `createGrantTable` refuses it, which is the real `adoptSession` throw
 * these legs induce AFTER the bindings and the lease were granted. The
 * `refuseGrant` option swaps in the refused-grant coordinator stand-in
 * (F6's `failed` result after the real revocation pass). The
 * `hostHandshake` option (#362) wires the REAL Electron adoption seam
 * over the harness inputs — the same call `createControlPlaneComposition`
 * makes, never a re-derivation of its ordering.
 */
async function bootHarness(
  options: {
    readonly refuseGrant?: boolean;
    readonly hostHandshake?: HostMainFrameHandshake;
    /** The manual runs' inspect seam (#370): the styles legs script the route-selection/styles answers here. */
    readonly runInspect?: ProjectRun['inspect'];
  } = {},
): Promise<Harness> {
  const scratch = await mkdtemp(join(tmpdir(), 'astroix-stranded-adoption-'));
  const rootA = join(scratch, 'project-a');
  await mkdir(rootA);
  const rootB = join(scratch, 'vanished-root');

  const journal: Journal = [];
  const reportedFailures: SessionFailure[] = [];
  const httpBindings = createClientBindings();
  const sessionClients = createSessionClients();
  // The composition's document authority (#246, H4): the adoption's
  // one-mint both-truths discipline — the same surface the shared
  // composition composes over these very tables.
  const authority: DocumentAuthority = createDocumentAuthority({
    httpBindings,
    clients: sessionClients,
  });
  const grants = createHostCapabilityGrants();
  const hub = createSseHub();
  const grantTables = new Map<string, GrantTable>();
  const writeExecutors = new Map<string, WriteExecutorHandle>();
  const editRevisions = new Map<string, number>();
  const privateStateDirectory = join(scratch, 'private-state');
  await mkdir(privateStateDirectory);
  const candidates = createCandidateStore();
  const seats = new Map<string, SessionSeat>();
  const pendingDevPorts: number[] = [];
  const runs: ManualRun[] = [];

  const supervisor = createSessionSupervisor({
    hostCapabilities: grants,
    clients: sessionClients,
    startCandidate: (request) => {
      const port = pendingDevPorts.shift();
      const manual = manualRun(options.runInspect);
      runs.push(manual);
      if (port !== undefined) candidates.remember(manual.run, port, request.sessionRef);
      return manual.run;
    },
  });

  const seatStore: SeatStore = {
    active: () => {
      const active = supervisor.snapshot().active;
      return active === undefined ? null : (seats.get(pairKey(active.ref)) ?? null);
    },
    adopt: (seat) => {
      seats.set(pairKey(seat.ref), seat);
    },
    drop: (ref) => {
      seats.delete(pairKey(ref));
    },
  };

  const grantEviction = (session: SessionRef): number => {
    const evicted = grantTables.get(pairKey(session))?.revokeSession(session) ?? 0;
    grantTables.delete(pairKey(session));
    return evicted;
  };
  const surfaces = {
    clients: sessionClients,
    hostCapabilities: grants,
    streams: hub,
    grants: { revokeSession: grantEviction },
    httpBindings,
  };
  const realCoordinator = createSwitchCoordinator(surfaces);
  const coordinator =
    options.refuseGrant === true ? refusingGrantCoordinator(realCoordinator) : realCoordinator;
  const realCompletion = createSessionCompletion({
    ...surfaces,
    reportFailedNoActive: (failure) => {
      journal.push('report:failed-no-active');
      reportedFailures.push(failure);
    },
    tombstones: {
      recordIncompleteReap: async () => {
        journal.push('tombstone:record');
      },
    },
  });
  // The journaling wrapper (the #236–#239 idiom over the REAL
  // completion): journals the transition variant the executor hands F7
  // and records the results the executor drops — the #349 assertions
  // read here (the honest variant consumed, never a fabricated report
  // shape).
  const completionResults: CompletionResult[] = [];
  const completion: SessionCompletion = {
    completeReplacement: async (input) => {
      journal.push(`completion:${input.commit.kind}`);
      const result = await realCompletion.completeReplacement(input);
      completionResults.push(result);
      return result;
    },
    completeQuit: realCompletion.completeQuit,
    handleIncompleteReap: realCompletion.handleIncompleteReap,
  };

  const inputs: ExecutorInputs = {
    registry: fakeRegistry([
      { projectKey: PROJECT_A, canonicalRoot: rootA },
      { projectKey: PROJECT_B, canonicalRoot: rootB },
    ]),
    supervisor,
    coordinator,
    completion,
    authority,
    seatStore,
    listener: fakeListener(journal),
    sessionClients,
    httpBindings,
    grantTables,
    writeExecutors,
    privateStateDirectory,
    editRevisions,
    pendingDevPorts,
    freePort: async () => {
      const port = 4100 + pendingDevPorts.length + runs.length;
      return port;
    },
    hub,
    candidates,
  };
  const executor = createExecutor(
    options.hostHandshake === undefined
      ? inputs
      : {
          ...inputs,
          host: electronHostAdoption(options.hostHandshake, inputs, seatStore),
        },
  );

  return {
    supervisor,
    seatStore,
    httpBindings,
    sessionClients,
    grants,
    grantTables,
    journal,
    reportedFailures,
    completionResults,
    runs,
    execute: executor.execute,
    close: async () => {
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

describe('the stranded-adoption convergence (#333, direction (a))', () => {
  it('leaves no 404-on-live-host window: a failed adoption after a committed switch converges through the F7 aftermath', async () => {
    const h = await bootHarness();
    try {
      // Generation 1 — a clean, adopted session to switch away from.
      const first = activationOf(await h.execute(activate(PROJECT_A, 'req-1')));
      expect(first.target.session.generation).toBe(1);
      expect(h.supervisor.snapshot().active?.ref.generation).toBe(1);
      expect(h.seatStore.active()?.ref.generation).toBe(1);

      // Generation 2 — the switch: the coordinator revoked the old
      // authority and granted the candidate, then the adoption dies on
      // the vanished root AFTER minting both editor bindings and the
      // origin lease. The activation still answers with its envelope —
      // over a snapshot that no longer strands the session.
      const second = activationOf(await h.execute(activate(PROJECT_B, 'req-2')));
      expect(second.target.session.generation).toBe(2);

      // The 404-on-live-host window is closed: the document surface's
      // `current()` reads exactly this active entry, and there is none —
      // the supervisor reports the failed no-active state, not a live
      // host with no seated editor.
      const snapshot = h.supervisor.snapshot();
      expect(snapshot.active).toBeUndefined();
      // 'crash', not 'revocation': the harness run's close report is
      // reason 'cancelled', the commit-time observer maps anything but
      // 'startup-timeout' to 'crash', and that observer is the surface
      // that clears the active entry in these legs — the
      // revocation-category completion failure reaches only the
      // declared no-op hook in this composition.
      expect(snapshot.lastFailure?.category).toBe('crash');
      expect(second.snapshot.active).toBeUndefined();
      expect(second.snapshot.lastFailure?.category).toBe('crash');
      expect(h.seatStore.active()).toBeNull();

      // The aftermath revoked exactly what the failed adoption granted:
      // the stranded lease retired (the host answers 421, never a 404
      // behind a live route) …
      expect(h.journal.indexOf('lease:grant:b')).toBeGreaterThanOrEqual(0);
      expect(h.journal.indexOf('lease:revoke:b')).toBeGreaterThan(
        h.journal.indexOf('lease:grant:b'),
      );
      // … both editor-binding truths are empty (a stale editor binding
      // is the dead-lock's other face — it refuses every successor's
      // bind) …
      expect(h.httpBindings.counts().editor).toBe(0);
      expect(h.sessionClients.counts().editor).toBe(0);
      // … and the granted candidate's project host capability is dead.
      expect(h.grants.current({ host: 'project', projectKey: PROJECT_B })).toBeNull();

      // The granted run was reaped — and the supervisor's crash
      // observation settled with it, which is what cleared the active
      // entry above (the reap settles `closed` after the observer
      // registered on it at the commit).
      expect(h.runs[1]?.stopCalls()).toBe(1);

      // F7's failed no-active report ran once, after the revocation
      // pass, with the completion-failure category.
      expect(h.reportedFailures).toHaveLength(1);
      expect(h.reportedFailures[0]?.category).toBe('revocation');
      expect(h.journal.indexOf('report:failed-no-active')).toBeGreaterThan(
        h.journal.indexOf('lease:revoke:b'),
      );
      // The incomplete-reap tail never ran — this was a normal
      // preparation, and the tombstone stays out of it.
      expect(h.journal).not.toContain('tombstone:record');

      // #349's honesty pin, both sides in one leg: generation 1's clean
      // adoption consumed the FIRST-COMMIT variant (no old session —
      // and it completed), generation 2's stranded switch consumed the
      // SWITCH transition, whose failed result preserves the ordered
      // pass's report over the receipt's bound OLD pair (generation 1)
      // — never the new session, never a fabricated shape.
      expect(h.journal).toContain('completion:first-commit');
      expect(h.journal).toContain('completion:committed');
      expect(h.completionResults[0]?.kind).toBe('activation-completed');
      const failedResults = h.completionResults.filter((entry) => entry.kind === 'failed');
      expect(failedResults).toHaveLength(1);
      const switchReport = failedResults[0];
      if (switchReport === undefined) throw new Error('expected the failed completion result');
      if (!('session' in switchReport.revoked)) {
        throw new Error(
          'expected the ordered pass report over the old pair, got the first-commit marker',
        );
      }
      expect(switchReport.revoked.session).toEqual(first.target.session);
      expect(switchReport.revoked.outcome).toBe('complete');
      expect(switchReport.revoked.steps).toHaveLength(5);
    } finally {
      await h.close();
    }
  });

  it('converges on the next activation instead of dead-locking on the stale active entry', async () => {
    const h = await bootHarness();
    try {
      await h.execute(activate(PROJECT_A, 'req-1'));
      await h.execute(activate(PROJECT_B, 'req-2')); // the converged stranded switch

      // The next activation converges: a fresh committed AND adopted
      // session — no concurrent-activation refusal, no second-editor
      // refusal, no occupied lease.
      const third = activationOf(await h.execute(activate(PROJECT_A, 'req-3')));
      expect(third.target.session.generation).toBe(3);
      expect(h.supervisor.snapshot().active?.ref.generation).toBe(3);
      const seat = h.seatStore.active();
      expect(seat).not.toBeNull();
      expect(seat?.ref.generation).toBe(3);
      expect(seat?.projectKey).toBe(PROJECT_A);
      expect(h.httpBindings.counts().editor).toBe(1);
      expect(h.grantTables.has(pairKey(third.target.session))).toBe(true);

      // The dead-lock's exact shape is gone: the stranded lease was
      // revoked strictly before the successor's grant, so the one-lease
      // law admits the successor instead of refusing it forever.
      expect(h.journal.lastIndexOf('lease:grant:a')).toBeGreaterThan(
        h.journal.indexOf('lease:revoke:b'),
      );
    } finally {
      await h.close();
    }
  });

  it('converges a failed FIRST adoption the same way — no old session ever existed to fall back to', async () => {
    const h = await bootHarness();
    try {
      // The first activation's adoption dies on the vanished root: the
      // plain commit granted authority, the adoption threw, and the
      // composition still converges (the first-activation leg of the
      // same aftermath — the honest empty revoked accounting).
      const first = activationOf(await h.execute(activate(PROJECT_B, 'req-1')));
      expect(first.target.session.generation).toBe(1);
      expect(h.supervisor.snapshot().active).toBeUndefined();
      // The same crash-law pin as the switch leg above: the observer's
      // category, not the completion failure's.
      expect(h.supervisor.snapshot().lastFailure?.category).toBe('crash');
      expect(h.seatStore.active()).toBeNull();
      expect(h.journal.indexOf('lease:revoke:b')).toBeGreaterThan(
        h.journal.indexOf('lease:grant:b'),
      );
      expect(h.httpBindings.counts().editor).toBe(0);
      expect(h.reportedFailures).toHaveLength(1);
      expect(h.reportedFailures[0]?.category).toBe('revocation');
      expect(h.runs[0]?.stopCalls()).toBe(1);

      // #349's honesty pin, first-commit side: the executor handed F7
      // the FIRST-COMMIT variant — no old session existed, so no
      // revocation pass ran — and the failed result preserves the
      // frozen first-commit accounting, never a fabricated report over
      // the new pair with empty steps.
      expect(h.journal).toContain('completion:first-commit');
      expect(h.completionResults).toHaveLength(1);
      const firstReport = h.completionResults[0];
      if (firstReport?.kind !== 'failed') throw new Error('expected the failed completion result');
      expect(firstReport.revoked).toBe(FIRST_COMMIT_REVOCATION);
      expect(firstReport.revoked).toEqual({ kind: 'first-commit' });

      // And the next activation still converges onto a real session.
      const second = activationOf(await h.execute(activate(PROJECT_A, 'req-2')));
      expect(second.target.session.generation).toBe(2);
      expect(h.supervisor.snapshot().active?.ref.generation).toBe(2);
      expect(h.seatStore.active()?.ref.generation).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('routes the F6 failed-grant result through the completion — the report runs over the revoked accounting (the review T1 leg)', async () => {
    const h = await bootHarness({ refuseGrant: true });
    try {
      // Generation 1 — the live session to switch away from.
      const first = activationOf(await h.execute(activate(PROJECT_A, 'req-1')));
      expect(first.target.session.generation).toBe(1);

      // Generation 2 — the switch whose GRANT refuses after the
      // coordinator's real revocation pass: F6's own irreversible
      // `failed` result. It rides `completeReplacement` unchanged —
      // the same §4 step 7 machinery, with the candidate revocation
      // correctly skipped (the candidate was never granted).
      const second = activationOf(await h.execute(activate(PROJECT_B, 'req-2')));
      expect(second.target.session.generation).toBe(2);
      // The completion consumed F6's `failed` variant — the route the
      // wrapper journals proves it reached the real machine.
      expect(h.journal).toContain('completion:failed');

      // The failed-no-active report ran exactly once, strictly after
      // the old-side revocation pass, with F6's post-revocation
      // failure category.
      expect(h.reportedFailures).toHaveLength(1);
      expect(h.reportedFailures[0]?.category).toBe('revocation');
      expect(h.journal.indexOf('lease:revoke:a')).toBeGreaterThanOrEqual(0);
      expect(h.journal.indexOf('report:failed-no-active')).toBeGreaterThan(
        h.journal.indexOf('lease:revoke:a'),
      );

      // The old side genuinely revoked — the old lease retired and both
      // editor-binding truths are empty (no adoption ever ran, so
      // nothing new was bound) — and nothing was granted on the
      // candidate side for the aftermath to revoke.
      expect(h.journal).not.toContain('lease:grant:b');
      expect(h.httpBindings.counts().editor).toBe(0);

      // The orphaned candidate run converged exactly once — F4's own
      // attempt machine (the settled attempt), never a second reap —
      // and the generation reservation is freed.
      expect(h.runs[1]?.stopCalls()).toBe(1);
      expect(h.supervisor.snapshot().attempt).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it('retires the PRE-GRANTED lease when the handshake dies before the adoption — the trail records at grant time (#362)', async () => {
    // The Electron host's seam grants the origin lease BEFORE the
    // phase-1 ask (the origin must serve before the host can load
    // anything from it) — a host that cannot report the current
    // document throws between the grant and `adoptSession`, where
    // nothing but the trail's grant-time record can carry the lease
    // into the aftermath's ordered pass. An unrecorded lease would
    // answer `neverGrantedRoutes`, retire nothing, and the router's
    // one-active-lease law (enforced by the harness listener, as the
    // real one enforces it) would then refuse every later activation
    // for the rest of the boot.
    let asks = 0;
    const identity = (navigationId: number): HostDocumentIdentity => ({
      webContentsId: 7,
      navigationId,
    });
    const h = await bootHarness({
      hostHandshake: {
        currentDocument: async () => {
          asks += 1;
          return asks === 1 ? null : identity(1);
        },
        replaceTopLevel: async () => identity(2),
      },
    });
    try {
      // The first ask cannot report a document: the grant is live, the
      // adoption dies before any of its own records, and the F7
      // aftermath converges over the trail alone.
      const first = activationOf(await h.execute(activate(PROJECT_A, 'req-1')));
      expect(first.target.session.generation).toBe(1);
      expect(h.supervisor.snapshot().active).toBeUndefined();
      expect(h.seatStore.active()).toBeNull();
      // THE pin: the pre-granted lease was retired strictly after its
      // grant, before the failed-no-active report — the trail drove the
      // ordered pass, never the never-granted escape.
      expect(h.journal).toContain('lease:grant:a');
      expect(h.journal.indexOf('lease:revoke:a')).toBeGreaterThan(
        h.journal.indexOf('lease:grant:a'),
      );
      expect(h.journal.indexOf('report:failed-no-active')).toBeGreaterThan(
        h.journal.indexOf('lease:revoke:a'),
      );
      expect(h.reportedFailures).toHaveLength(1);

      // The consequence: the next activation converges. With the lease
      // escaped (the defect), the one-lease law refuses the second
      // grant inside the handshake itself — and every grant after it,
      // until app quit.
      const second = activationOf(await h.execute(activate(PROJECT_A, 'req-2')));
      expect(second.target.session.generation).toBe(2);
      expect(h.supervisor.snapshot().active?.ref.generation).toBe(2);
      const seat = h.seatStore.active();
      expect(seat?.projectKey).toBe(PROJECT_A);
      // The full Electron adoption held: the seat's document is the
      // OBSERVED post-replacement one (the rebind), never the phase-1
      // bind the replacement invalidated.
      expect(seat?.document).toEqual({ webContentsId: 7, navigationId: 2 });
      expect(h.journal.lastIndexOf('lease:grant:a')).toBeGreaterThan(
        h.journal.indexOf('lease:revoke:a'),
      );
    } finally {
      await h.close();
    }
  });
});

/** One inspect request envelope — the session-scoped command over an inspection request. */
function inspectRequest(
  session: SessionRef | undefined,
  request: unknown,
  requestId: string,
): RequestEnvelope {
  return {
    protocolVersion: 1,
    requestId,
    ...(session === undefined ? {} : { session }),
    command: { kind: 'inspect', request },
  } as RequestEnvelope;
}

/**
 * The #370 legs: the styles inspection's wire-carried route selection,
 * mapped end-to-end through the executor. The run seam is scripted
 * exactly at the run boundary (the sanctioned stand-in level — the
 * resolution seam and the worker dispatch have their own focused
 * suites): a route-selection dispatch answers with the resolved
 * component (or the honest unresolvable null), and the styles dispatch
 * that follows must carry exactly that component as its
 * `routeComponent`. The matrix the issue names — selection
 * present/absent, resolvable/unresolvable, stale session — plus the
 * disclosure sweep: the component never enters a response envelope.
 */
describe('the styles inspection route selection (#370)', () => {
  /** A scripted run inspect: records every dispatch, answers route-selection and styles. */
  function scriptedRun(selection: { readonly pattern: string; readonly component: string } | null) {
    const dispatched: unknown[] = [];
    const inspect: ProjectRun['inspect'] = async (request) => {
      dispatched.push(request);
      if (request.kind === 'route-selection') {
        return { kind: 'route-selection', revision: 1, payload: { revision: 1, selection } };
      }
      return {
        kind: 'styles',
        revision: 4,
        payload: { revision: 4, invalidationRevision: 2, records: [] },
      };
    };
    return { inspect, dispatched };
  }

  it('serves a styles inspection by resolving the observed pathname and dispatching the component', async () => {
    const script = scriptedRun({
      pattern: '/blog/[slug]',
      component: 'src/pages/blog/[slug].astro',
    });
    const h = await bootHarness({ runInspect: script.inspect });
    try {
      const first = activationOf(await h.execute(activate(PROJECT_A, 'req-1')));
      const response = await h.execute(
        inspectRequest(
          first.target.session,
          { kind: 'styles', route: '/blog/hello-builder' },
          'req-2',
        ),
      );
      if (!('protocolVersion' in response) || response.result.kind !== 'inspection') {
        throw new Error(`expected an inspection envelope, received: ${JSON.stringify(response)}`);
      }
      // The served result is the WORKER's styles answer, verbatim.
      expect(response.result.result).toEqual({
        kind: 'styles',
        revision: 4,
        payload: { revision: 4, invalidationRevision: 2, records: [] },
      });
      // The mapping is the ruled two-step: route-selection in, then the
      // styles request carrying exactly the resolved component.
      expect(script.dispatched).toEqual([
        { kind: 'route-selection', route: '/blog/hello-builder' },
        { kind: 'styles', routeComponent: 'src/pages/blog/[slug].astro' },
      ]);
      // The disclosure sweep: the component — the pattern is public, the
      // component is not — never enters the served envelope.
      expect(JSON.stringify(response)).not.toContain('src/pages');
      expect(JSON.stringify(response)).not.toContain('route-selection');
    } finally {
      await h.close();
    }
  });

  it('answers an unresolvable route with the route-shaped 404 — never a component, never a guess', async () => {
    const script = scriptedRun(null);
    const h = await bootHarness({ runInspect: script.inspect });
    try {
      const first = activationOf(await h.execute(activate(PROJECT_A, 'req-1')));
      const response = await h.execute(
        inspectRequest(first.target.session, { kind: 'styles', route: '/no/such/route' }, 'req-2'),
      );
      expect(response).toEqual({
        code: 'resource-not-found',
        message: 'the requested resource does not exist',
        retryable: false,
        details: { what: 'route' },
      });
      // The resolution dispatched once; no styles request follows a 404.
      expect(script.dispatched).toEqual([{ kind: 'route-selection', route: '/no/such/route' }]);
    } finally {
      await h.close();
    }
  });

  it('refuses a styles request without a selection — the additive envelope parses, the inspection cannot serve', async () => {
    const script = scriptedRun({ pattern: '/', component: 'src/pages/index.astro' });
    const h = await bootHarness({ runInspect: script.inspect });
    try {
      const first = activationOf(await h.execute(activate(PROJECT_A, 'req-1')));
      const response = await h.execute(
        inspectRequest(first.target.session, { kind: 'styles' }, 'req-2'),
      );
      expect(response).toEqual({
        code: 'malformed-request',
        message: 'a styles inspection must carry the observed canvas route',
        retryable: false,
        details: { issue: 'invalid-shape', pointer: 'command.request' },
      });
      // Nothing dispatched: there is no selection to resolve.
      expect(script.dispatched).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('refuses a stale session before any resolution runs', async () => {
    const script = scriptedRun({ pattern: '/', component: 'src/pages/index.astro' });
    const h = await bootHarness({ runInspect: script.inspect });
    try {
      await activationOf(await h.execute(activate(PROJECT_A, 'req-1')));
      const stale = await h.execute(
        inspectRequest(
          { runtimeEpoch: 'stale-epoch', generation: 99 },
          { kind: 'styles', route: '/' },
          'req-2',
        ),
      );
      expect(stale).toEqual({
        code: 'stale-session',
        message: 'the request carries a session that is not the current one',
        retryable: false,
      });
      expect(script.dispatched).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('answers the closed catch-all when the run rejects a dispatch — never the raw error', async () => {
    const dispatched: unknown[] = [];
    const inspect: ProjectRun['inspect'] = async (request) => {
      dispatched.push(request);
      throw new Error('a raw worker failure at /Users/secret/project-root');
    };
    const h = await bootHarness({ runInspect: inspect });
    try {
      const first = activationOf(await h.execute(activate(PROJECT_A, 'req-1')));
      const response = await h.execute(
        inspectRequest(first.target.session, { kind: 'styles', route: '/' }, 'req-2'),
      );
      expect(response).toEqual({
        code: 'internal-error',
        message: 'the request could not be completed',
        retryable: false,
      });
      expect(JSON.stringify(response)).not.toContain('/Users/secret');
      expect(dispatched).toEqual([{ kind: 'route-selection', route: '/' }]);
    } finally {
      await h.close();
    }
  });

  it('still serves the three selection-less families 1:1 — the additive envelope changed nothing else', async () => {
    const dispatched: unknown[] = [];
    const inspect: ProjectRun['inspect'] = async (request) => {
      dispatched.push(request);
      return { kind: 'routes', revision: 1, payload: { revision: 1, routes: [] } };
    };
    const h = await bootHarness({ runInspect: inspect });
    try {
      const first = activationOf(await h.execute(activate(PROJECT_A, 'req-1')));
      const response = await h.execute(
        inspectRequest(first.target.session, { kind: 'routes' }, 'req-2'),
      );
      if (!('protocolVersion' in response) || response.result.kind !== 'inspection') {
        throw new Error(`expected an inspection envelope, received: ${JSON.stringify(response)}`);
      }
      expect(response.result.result.kind).toBe('routes');
      expect(dispatched).toEqual([{ kind: 'routes' }]);
    } finally {
      await h.close();
    }
  });
});

describe("the composition teardown's owned-run stop (#365 addendum, #391)", () => {
  /**
   * The gated run: stop() records the call and settles only when the
   * leg opens the gate — the await itself is the thing under proof,
   * never merely the invocation.
   */
  function gatedRun(): {
    readonly run: ProjectRun;
    readonly stopCalls: () => number;
    readonly open: () => void;
  } {
    let stopCalls = 0;
    let open: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      open = resolve;
    });
    const report = stopped.then(() => completeCloseReport());
    const run: ProjectRun = {
      ready: Promise.resolve(),
      inspect: () => Promise.reject(new Error('inspection is not this lane\u2019s subject')),
      subscribe: () => () => {},
      stop: () => {
        stopCalls += 1;
        return report;
      },
      closed: report,
    };
    return { run, stopCalls: () => stopCalls, open };
  }

  it('awaits every owned run at close — the unseated candidate included, the shared seat exactly once', async () => {
    const seated = gatedRun();
    const candidate = gatedRun();
    const candidates = createCandidateStore();
    const seat: SessionSeat = {
      ref: { runtimeEpoch: 'epoch-owned-runs', generation: 1 },
      projectKey: PROJECT_A,
      run: seated.run,
      devServerPort: 4310,
      lease: null as unknown as OriginLease,
      fence: createEditFence(),
      editorCapability: 'editor-capability-fixture',
      document: { webContentsId: 1, navigationId: 1 },
      clientCapability: 'client-capability-fixture',
    };
    // The seated run is ALSO a remembered candidate (adoption leaves
    // its entry), and one unseated staged candidate exists beside it —
    // the close-time shape the old close() orphaned
    candidates.remember(seat.run, 4310, seat.ref);
    candidates.remember(candidate.run, 4311, { runtimeEpoch: 'epoch-owned-runs', generation: 2 });

    let settled = false;
    const closing = stopOwnedRuns(seat, candidates).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Both DISTINCT runs were stopped — the unseated candidate\'s close
    // is driven, and the shared seat exactly once (the dedupe) — while
    // neither stop has settled yet: the awaits are real, never
    // fire-and-forget
    expect(seated.stopCalls()).toBe(1);
    expect(candidate.stopCalls()).toBe(1);
    expect(settled).toBe(false);

    candidate.open();
    await new Promise((resolve) => setImmediate(resolve));
    // The candidate\'s close alone does not settle the pass — the
    // seated run\'s stop is still awaited
    expect(settled).toBe(false);

    seated.open();
    await closing;
    expect(settled).toBe(true);
  });

  it('stops an unseated candidate with no active seat at all — the close covers runs the seat store never held', async () => {
    const lone = gatedRun();
    const candidates = createCandidateStore();
    candidates.remember(lone.run, 4310, { runtimeEpoch: 'epoch-owned-runs', generation: 3 });
    let settled = false;
    const closing = stopOwnedRuns(null, candidates).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(lone.stopCalls()).toBe(1);
    expect(settled).toBe(false);
    lone.open();
    await closing;
    expect(settled).toBe(true);
  });
});

describe("the composition teardown's write-executor stop bound (#410)", () => {
  /**
   * The unresponsive child: alive, never answering the stop control —
   * no `closed` message, no exit — the shape that used to hang close()
   * past every bound (the pre-#410 loop awaited `stop()` directly, and
   * this promise never settles). `kill` records the force path the way
   * the real handle's does (SIGKILL, the stop promise settling on the
   * observed exit).
   */
  function hungHandle(): { readonly handle: WriteExecutorHandle; readonly kills: () => number } {
    let kills = 0;
    const handle: WriteExecutorHandle = {
      ready: Promise.resolve(),
      execute: () => new Promise(() => {}),
      stop: () => new Promise(() => {}),
      kill: async () => {
        kills += 1;
      },
      exited: new Promise(() => {}),
    };
    return { handle, kills: () => kills };
  }

  /**
   * The healthy child: its graceful stop settles the moment the leg
   * opens the gate — the `closed`-message happy path.
   */
  function gatedHandle(): {
    readonly handle: WriteExecutorHandle;
    readonly kills: () => number;
    readonly open: () => void;
  } {
    let kills = 0;
    let open: () => void = () => {};
    const stop = new Promise<void>((resolve) => {
      open = resolve;
    });
    const handle: WriteExecutorHandle = {
      ready: Promise.resolve(),
      execute: () => new Promise(() => {}),
      stop: () => stop,
      kill: async () => {
        kills += 1;
      },
      exited: new Promise(() => {}),
    };
    return { handle, kills: () => kills, open };
  }

  it('resolves at the bound on an unresponsive child — the timeout verdict, the lease released through the force path', async () => {
    const hung = hungHandle();
    const started = Date.now();
    // An un-bounded stop wait (the reverted remedy) never settles on
    // this handle — the leg times out red on that tree; on this tree
    // the pass resolves at the injected bound.
    const report = await stopOwnedWriteExecutors([hung.handle], 50);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(report).toBe('timed-out');
    // The hung child is disposed through the D5 force path — the
    // observed exit the lease release rides — exactly once
    expect(hung.kills()).toBe(1);
  });

  it('settles a graceful stop immediately, never waiting the bound — and no force path fires', async () => {
    const healthy = gatedHandle();
    const started = Date.now();
    const stopping = stopOwnedWriteExecutors([healthy.handle], 2000);
    await new Promise((resolve) => setImmediate(resolve));
    healthy.open();
    const report = await stopping;
    // The happy paths (the closed message, the exit) are unchanged:
    // the pass settles when the child answers, well inside the bound
    expect(Date.now() - started).toBeLessThan(2000);
    expect(report).toBe('stopped');
    expect(healthy.kills()).toBe(0);
  });

  it('reports the worst verdict across the pass — the hung child alone is disposed, the settled one untouched', async () => {
    const hung = hungHandle();
    const healthy = gatedHandle();
    const stopping = stopOwnedWriteExecutors([healthy.handle, hung.handle], 50);
    await new Promise((resolve) => setImmediate(resolve));
    healthy.open();
    expect(await stopping).toBe('timed-out');
    expect(hung.kills()).toBe(1);
    expect(healthy.kills()).toBe(0);
  });
});

describe('the edit-outcome deadline tie (#410)', () => {
  it("the executor's edit-outcome deadline IS the fence's drain deadline — one constant through the public surface", () => {
    // The pre-#410 tree restated the literal here; this pin fails that
    // tree's shape at load (no export) and fails a future divergence at
    // the assertion — a drain-deadline change the composition does not
    // follow is a gate-red, never a silent early give-up.
    expect(EDIT_OUTCOME_DEADLINE_MS).toBe(DRAIN_DEADLINE_MS);
  });
});
