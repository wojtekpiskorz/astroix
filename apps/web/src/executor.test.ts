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
import type { GrantTable } from '@wojciechpiskorz/astroix-runtime/edit-authority/grants';
import type { OriginLease, OriginListener } from '@wojciechpiskorz/astroix-runtime/origin';
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
import { FIRST_COMMIT_REVOCATION } from '@wojciechpiskorz/astroix-runtime/session-supervisor/revocation';
import {
  createSessionSupervisor,
  type SessionSupervisor,
  type SupervisionCloseReport,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/staging';
import { createSseHub } from '@wojciechpiskorz/astroix-runtime/sse';
import { describe, expect, it } from 'vitest';
import { createCandidateStore, pairKey } from './candidates.ts';
import { createExecutor, type SeatStore, type SessionSeat } from './executor.ts';

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

function manualRun(): ManualRun {
  let stopCalls = 0;
  let settle: (report: SupervisionCloseReport) => void = () => {};
  const closed = new Promise<SupervisionCloseReport>((resolve) => {
    settle = resolve;
  });
  const run: ProjectRun = {
    ready: Promise.resolve(),
    inspect: () => Promise.reject(new Error("inspection is not this lane's subject")),
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
      journal.push(`lease:grant:${input.projectKey[0]}`);
      const lease: OriginLease = {
        projectKey: input.projectKey,
        hostname: `${input.projectKey}.localhost`,
        origin: `http://${input.projectKey}.localhost:0`,
        revoked: false,
        revoke: async () => {
          journal.push(`lease:revoke:${input.projectKey[0]}`);
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
 * (F6's `failed` result after the real revocation pass).
 */
async function bootHarness(options: { readonly refuseGrant?: boolean } = {}): Promise<Harness> {
  const scratch = await mkdtemp(join(tmpdir(), 'astroix-stranded-adoption-'));
  const rootA = join(scratch, 'project-a');
  await mkdir(rootA);
  const rootB = join(scratch, 'vanished-root');

  const journal: Journal = [];
  const reportedFailures: SessionFailure[] = [];
  const httpBindings = createClientBindings();
  const sessionClients = createSessionClients();
  const grants = createHostCapabilityGrants();
  const hub = createSseHub();
  const grantTables = new Map<string, GrantTable>();
  const candidates = createCandidateStore();
  const seats = new Map<string, SessionSeat>();
  const pendingDevPorts: number[] = [];
  const runs: ManualRun[] = [];

  const supervisor = createSessionSupervisor({
    hostCapabilities: grants,
    clients: sessionClients,
    startCandidate: (request) => {
      const port = pendingDevPorts.shift();
      const manual = manualRun();
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

  const executor = createExecutor({
    registry: fakeRegistry([
      { projectKey: PROJECT_A, canonicalRoot: rootA },
      { projectKey: PROJECT_B, canonicalRoot: rootB },
    ]),
    supervisor,
    coordinator,
    completion,
    seatStore,
    listener: fakeListener(journal),
    sessionClients,
    httpBindings,
    grantTables,
    pendingDevPorts,
    freePort: async () => {
      const port = 4100 + pendingDevPorts.length + runs.length;
      return port;
    },
    hub,
    candidates,
  });

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
        throw new Error('the switch preserves the ordered pass report');
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
});
