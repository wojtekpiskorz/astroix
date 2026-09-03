import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { ClientBindings } from '../../api/http/client-bindings.ts';
import { createClientBindings } from '../../api/http/client-bindings.ts';
import type { HostCapabilityGrants } from '../../api/http/host-capability.ts';
import { createHostCapabilityGrants } from '../../api/http/host-capability.ts';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import {
  shutdownFailure,
  WorkerRejectionError,
} from '../../project-plane/worker/worker-failure.ts';
import type { ProjectRun } from '../../project-runtime/project-runtime.ts';
import {
  ProjectRunBootError,
  type ProjectRunBootErrorCode,
} from '../../project-runtime/project-runtime.ts';
import type { SessionClients } from '../../session-supervisor/clients/session-clients.ts';
import { createSessionClients } from '../../session-supervisor/clients/session-clients.ts';
import type {
  CommittedTransition,
  ForcedExecutor,
  SwitchCoordinator,
} from '../../session-supervisor/commit/switch-coordinator.ts';
import { createSwitchCoordinator } from '../../session-supervisor/commit/switch-coordinator.ts';
import type { AuthoritativeClient } from '../../session-supervisor/commit/switch-receipt.ts';
import type {
  DrainClock,
  EditDrain,
  EditFence,
} from '../../session-supervisor/fence/edit-fence.ts';
import { createEditFence } from '../../session-supervisor/fence/edit-fence.ts';
import type {
  LeaseRevocationView,
  RoutesTarget,
} from '../../session-supervisor/revocation/authority-revocation.ts';
import type {
  SessionSupervisor,
  StagedCandidate,
  StartCandidateRun,
} from '../../session-supervisor/staging/session-supervisor.ts';
import { createSessionSupervisor } from '../../session-supervisor/staging/session-supervisor.ts';
import type { SseHub } from '../../sse/sse-hub.ts';
import { createSseHub } from '../../sse/sse-hub.ts';

/**
 * The #238 focused-test stand-ins, at the sanctioned level (the #236/
 * #237 harness idiom): journaling wrappers over the REAL landed
 * surfaces (F2's capability/binding tables, F3's hub, F4's client
 * registry and supervisor) so the ordering legs observe the exact
 * sequence the coordinator drives — every old-side revocation before
 * the candidate grant's mint; a fake per-session origin lease and a
 * fake D4 grant table (the revocation-facing slices only — the real
 * grant table joins the A-to-B-to-A battery, where grant *rejection*
 * is the behavior); the slim fake ProjectRun; manual clocks for both
 * the drain and the forced-reap deadlines; and a fake write executor
 * whose exit observation the test settles by hand. No real timers in
 * the pure legs; the real-socket legs (the battery's origin listener)
 * use OS-assigned loopback ports.
 */

export const EPOCH = 'epoch-238';

/** Two valid, distinct project keys (26 lowercase-base32 characters, the protocol's shape). */
export const PROJECT_A: ProjectKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
export const PROJECT_B: ProjectKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';

/** The authoritative editor's document — one webContents, its first navigation. */
export const EDITOR_DOC = { webContentsId: 7, navigationId: 1 } as const;

/** One macrotask boundary — every chained microtask of a settled promise has run. */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The ordered-event journal: the order-recording seam over every revocation entry point and the grant. */
export type Journal = string[];

/** Field-wise pair equality — the tests' own oracle (never the modules'). */
export function sameRef(left: SessionRef, right: SessionRef): boolean {
  return left.runtimeEpoch === right.runtimeEpoch && left.generation === right.generation;
}

// ——— the slim fake ProjectRun (the #236/#237 idiom, pared to this lane) ———

export interface FakeRun {
  readonly run: ProjectRun;
  settleReady(): void;
  closeWith(report: SupervisionCloseReport): void;
  readonly stopCalls: number;
}

/** A boring complete close report — tests override fields as needed. */
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

export function fakeRun(): FakeRun {
  let stopCalls = 0;
  let readySettled = false;
  let closedSettled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  let settleClosed: (report: SupervisionCloseReport) => void = () => {};
  const closed = new Promise<SupervisionCloseReport>((resolve) => {
    settleClosed = resolve;
  });
  const settleOnce = (report: SupervisionCloseReport): void => {
    if (closedSettled) return;
    closedSettled = true;
    settleClosed(report);
  };
  const run: ProjectRun = {
    ready,
    inspect: () => Promise.reject(new WorkerRejectionError(shutdownFailure())),
    subscribe: () => () => {},
    stop: () => {
      stopCalls += 1;
      if (!readySettled) {
        readySettled = true;
        rejectReady(new ProjectRunBootError('cancelled'));
      }
      return closed;
    },
    closed,
  };
  return {
    run,
    settleReady: () => {
      readySettled = true;
      resolveReady();
    },
    closeWith: (report) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new ProjectRunBootError(
            (report.reason === 'startup-timeout'
              ? 'startup-timeout'
              : 'cancelled') satisfies ProjectRunBootErrorCode,
          ),
        );
      }
      settleOnce(report);
    },
    get stopCalls() {
      return stopCalls;
    },
  };
}

// ——— the manual clock (both deadlines: the drain's and the forced reap's) ———

export interface ManualClock {
  readonly clock: DrainClock;
  /** Every delay the machine armed, in order. */
  armedDelays(): readonly number[];
  /** Fires the one armed deadline (a no-op when disarmed or already fired). */
  fireDeadline(): void;
}

export function manualClock(): ManualClock {
  const delays: number[] = [];
  let armed: (() => void) | null = null;
  const clock: DrainClock = {
    delay: (ms, fire) => {
      delays.push(ms);
      armed = fire;
      return () => {
        armed = null;
      };
    },
  };
  return {
    clock,
    armedDelays: () => delays,
    fireDeadline: () => {
      const fire = armed;
      armed = null;
      fire?.();
    },
  };
}

// ——— the fake origin lease (the revocation-facing slice; the real listener joins the battery) ———

export interface FakeLease extends RoutesTarget {
  /** Configurable outcome — `complete` unless the test sets incomplete. */
  setOutcome(outcome: 'complete' | 'incomplete'): void;
  readonly revocations: number;
}

export function fakeLease(journal: Journal, mark: string): FakeLease {
  let outcome: 'complete' | 'incomplete' = 'complete';
  let revocations = 0;
  return {
    setOutcome: (next) => {
      outcome = next;
    },
    get revocations() {
      return revocations;
    },
    revoke: async (): Promise<LeaseRevocationView> => {
      revocations += 1;
      journal.push(mark);
      return { outcome, destroyedSockets: 2 };
    },
  };
}

// ——— the fake write executor (the exit-observation seam, D5's handle slice) ———

export interface FakeExecutor {
  readonly executor: ForcedExecutor;
  /** Resolves the exit observation — the observed exact exit. */
  settleExit(code: number | null, signal: NodeJS.Signals | null): void;
  readonly killCalls: number;
}

export function fakeExecutor(): FakeExecutor {
  let killCalls = 0;
  let settleExit: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    settleExit = resolve;
  });
  return {
    executor: {
      kill: () => {
        killCalls += 1;
        return Promise.resolve();
      },
      exited,
    },
    settleExit: (code, signal) => {
      settleExit({ code, signal });
    },
    get killCalls() {
      return killCalls;
    },
  };
}

// ——— the journaling pure fixture: the real surfaces, wrapped for order ———

/** One session's composition record — everything a switch binds, plus its tab's authority. */
export interface SessionSeat {
  readonly ref: SessionRef;
  readonly projectKey: ProjectKey;
  readonly fence: EditFence;
  readonly fenceClock: ManualClock;
  drain: EditDrain | null;
  readonly lease: FakeLease;
  readonly client: AuthoritativeClient;
  /** The host capability this session's tab holds (the cookie's value). */
  readonly cookie: string;
}

export interface CommitFixture {
  readonly supervisor: SessionSupervisor;
  readonly coordinator: SwitchCoordinator;
  readonly clients: SessionClients;
  readonly httpBindings: ClientBindings;
  readonly capabilityGrants: HostCapabilityGrants;
  readonly hub: SseHub;
  /** The fake D4 surface's per-session live-grant counts (the eviction's return). */
  readonly liveGrants: Map<string, number>;
  readonly grantEvictions: readonly SessionRef[];
  /** Makes the fake D4 surface throw on the next revokeSession (the fail-continue leg). */
  failNextGrantRevocation: boolean;
  readonly journal: Journal;
  readonly runs: readonly FakeRun[];
  readonly reapClock: ManualClock;
  /** The current active session's seat — the composition's own bookkeeping, updated by the helpers. */
  active: SessionSeat | null;
}

/** Builds the journaling composition: real F2/F3/F4 surfaces, fake lease + D4 slice, the coordinator over all of it. */
export function commitFixture(): CommitFixture {
  const journal: Journal = [];
  const runs: FakeRun[] = [];
  const grantEvictions: SessionRef[] = [];
  const liveGrants = new Map<string, number>();
  const realClients = createSessionClients();
  const realHttpBindings = createClientBindings();
  const realGrants = createHostCapabilityGrants();
  const realHub = createSseHub();
  let failNextGrantRevocation = false;

  // The journaling wrappers: the SAME objects the supervisor and the
  // coordinator share, so the one journal observes both sides' calls in
  // true interleaved order.
  const clients: SessionClients = {
    bind: (input) => realClients.bind(input),
    authorize: (request) => realClients.authorize(request),
    navigated: (document) => realClients.navigated(document),
    rendererLost: (webContentsId) => realClients.rendererLost(webContentsId),
    revokeSession: (sessionRef) => {
      journal.push('clients:revokeSession');
      return realClients.revokeSession(sessionRef);
    },
    revoke: (capability) => realClients.revoke(capability),
    counts: () => realClients.counts(),
  };
  const httpBindings: ClientBindings = {
    bind: (input) => realHttpBindings.bind(input),
    unbind: (capability) => {
      journal.push('http-bindings:unbind');
      return realHttpBindings.unbind(capability);
    },
    resolve: (presented) => realHttpBindings.resolve(presented),
    counts: () => realHttpBindings.counts(),
  };
  const capabilityGrants: HostCapabilityGrants = {
    mint: (target) => {
      journal.push('grant:mint');
      return realGrants.mint(target);
    },
    revoke: (target) => {
      journal.push('host-capability:revoke');
      return realGrants.revoke(target);
    },
    verify: (presented, target) => realGrants.verify(presented, target),
    current: (target) => realGrants.current(target),
  };
  const hub: SseHub = {
    admit: (record) => realHub.admit(record),
    drop: (id) => realHub.drop(id),
    endForHost: (host) => {
      journal.push('streams:endForHost');
      return realHub.endForHost(host);
    },
    endForSession: (session) => {
      journal.push('streams:endForSession');
      return realHub.endForSession(session);
    },
    endForBinding: (clientCapability) => {
      journal.push('streams:endForBinding');
      return realHub.endForBinding(clientCapability);
    },
    publish: (publication) => realHub.publish(publication),
    counts: () => realHub.counts(),
  };
  const grantSurface = {
    revokeSession: (sessionRef: SessionRef): number => {
      if (failNextGrantRevocation) {
        failNextGrantRevocation = false;
        journal.push('edit-grants:threw');
        throw new Error('grant surface defect');
      }
      journal.push('edit-grants:revokeSession');
      grantEvictions.push(sessionRef);
      const evicted = liveGrants.get(refKey(sessionRef)) ?? 0;
      liveGrants.delete(refKey(sessionRef));
      return evicted;
    },
  };

  const startCandidate: StartCandidateRun = () => {
    const fake = fakeRun();
    runs.push(fake);
    return fake.run;
  };
  const supervisor = createSessionSupervisor({
    startCandidate,
    runtimeEpoch: EPOCH,
    hostCapabilities: capabilityGrants,
    clients,
  });
  const reapClock = manualClock();
  const coordinator = createSwitchCoordinator({
    clients,
    hostCapabilities: capabilityGrants,
    streams: hub,
    grants: grantSurface,
    httpBindings,
    reapClock: reapClock.clock,
  });

  return {
    supervisor,
    coordinator,
    clients,
    httpBindings,
    capabilityGrants,
    hub,
    liveGrants,
    grantEvictions,
    get failNextGrantRevocation() {
      return failNextGrantRevocation;
    },
    set failNextGrantRevocation(next: boolean) {
      failNextGrantRevocation = next;
    },
    journal,
    runs,
    reapClock,
    active: null,
  };
}

export function refKey(ref: SessionRef): string {
  return `${ref.runtimeEpoch}#${ref.generation}`;
}

/** One session's seat: the fence, its manual clock, the fake lease, and the editor bound at the pair on both tables. */
export function seatFor(
  fx: CommitFixture,
  ref: SessionRef,
  projectKey: ProjectKey,
  journal: Journal,
): SessionSeat {
  const fenceClock = manualClock();
  const fence = createEditFence({ clock: fenceClock.clock });
  const lease = fakeLease(journal, 'routes:revoke');
  const bound = fx.clients.bind({ role: 'editor', document: EDITOR_DOC, sessionRef: ref });
  if (bound.kind !== 'bound') throw new Error('expected the editor binding');
  const http = fx.httpBindings.bind({ role: 'editor', host: 'project', sessionRef: ref });
  if (http.kind !== 'bound') throw new Error('expected the HTTP editor binding');
  return {
    ref,
    projectKey,
    fence,
    fenceClock,
    drain: null,
    lease,
    client: { document: EDITOR_DOC, capability: bound.capability, httpCapability: http.capability },
    cookie: fx.capabilityGrants.current({ host: 'project', projectKey }) ?? '',
  };
}

/** Begins one candidate and returns its staged handle — the composition's begin half. */
export async function beginCandidate(
  fx: CommitFixture,
  projectKey: ProjectKey,
): Promise<StagedCandidate> {
  const begun = fx.supervisor.begin(projectKey);
  if (begun.kind !== 'begun') throw new Error(`expected admission, refused: ${begun.reason}`);
  const run = fx.runs[fx.runs.length - 1];
  if (run === undefined) throw new Error('no candidate run was started');
  run.settleReady();
  return await begun.attempt.ready;
}

/**
 * The first activation's plain commit (F4's own machine — no old
 * session exists, so there is nothing to drain, bind, or revoke: no
 * receipt). Seats the session and returns its record.
 */
export async function activateFirst(
  fx: CommitFixture,
  projectKey: ProjectKey,
): Promise<SessionSeat> {
  const candidate = await beginCandidate(fx, projectKey);
  const result = await candidate.commit();
  const seat = seatFor(fx, result.committed, projectKey, fx.journal);
  fx.active = seat;
  return seat;
}

/** Runs one clean (empty) drain on the seat's fence — the terminal `drained` verdict. */
export async function drainClean(seat: SessionSeat): Promise<EditDrain> {
  const started = seat.fence.fence();
  if (started.kind !== 'fenced') throw new Error('expected the fence to start');
  seat.drain = started.drain;
  return await started.drain.outcome.then(() => started.drain);
}

/**
 * The receipt-gated switch (the composition this lane proves): mint the
 * normal receipt over the old session's terminal drain, consume it, and
 * grant the bound candidate. Asserts the commit landed, seats the
 * successor, and answers the committed transition result.
 */
export async function switchTo(
  fx: CommitFixture,
  projectKey: ProjectKey,
): Promise<CommittedTransition> {
  const old = fx.active;
  if (old === null) throw new Error('no active session to switch from');
  const candidate = await beginCandidate(fx, projectKey);
  const drain = old.drain ?? (await drainClean(old));
  const prepared = await fx.coordinator.prepareNormal({
    oldSession: old.ref,
    target: { kind: 'replacement', candidate: candidate.ref },
    client: old.client,
    fence: old.fence,
    drain,
    host: { host: 'project', projectKey: old.projectKey },
    routes: old.lease,
  });
  if (prepared.kind !== 'prepared') {
    throw new Error(`expected a prepared receipt, refused: ${prepared.reason}`);
  }
  const result = await fx.coordinator.commit(prepared.receipt, candidate);
  if (result.kind !== 'committed') {
    throw new Error(`expected a committed switch, got: ${result.kind}`);
  }
  fx.active = seatFor(fx, result.committed, projectKey, fx.journal);
  return result;
}

// ——— the real-root + real-socket helpers (the A-to-B-to-A battery) ———

const scratchDirs: string[] = [];

/** A realpath'd temp directory standing in for a canonical project root (the grants-harness idiom). */
export async function makeProjectRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'astroix-commit-')));
  scratchDirs.push(dir);
  return dir;
}

export async function cleanupScratch(): Promise<void> {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** One raw loopback exchange — exact request bytes in, status + head out (the F1 lane idiom). */
export function rawStatus(port: number, request: string, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(request);
    });
    let head = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(0);
    }, timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1');
      if (head.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.destroy();
      }
    });
    socket.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const match = /^HTTP\/1\.1 (\d{3})/.exec(head);
      resolve(match === null ? 0 : Number.parseInt(match[1] ?? '0', 10));
    });
  });
}

/** The raw GET the 421 legs send — Host evidence is the variable under test. */
export function rawGet(target: string, hostHeader: string): string {
  return `GET ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`;
}
