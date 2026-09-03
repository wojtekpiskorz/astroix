import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectKey, SessionFailure, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { ClientBindings } from '../../api/http/client-bindings.ts';
import { createClientBindings } from '../../api/http/client-bindings.ts';
import type { HostCapabilityGrants } from '../../api/http/host-capability.ts';
import { createHostCapabilityGrants } from '../../api/http/host-capability.ts';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import type { SessionClients } from '../../session-supervisor/clients/session-clients.ts';
import { createSessionClients } from '../../session-supervisor/clients/session-clients.ts';
import type {
  CompletionClientIdentity,
  GrantedCandidateTarget,
  HostCompletionObservations,
} from '../../session-supervisor/completion/completion-result.ts';
import type { SessionCompletion } from '../../session-supervisor/completion/replacement-completion.ts';
import { createSessionCompletion } from '../../session-supervisor/completion/replacement-completion.ts';
import type { RevocationReport } from '../../session-supervisor/revocation/authority-revocation.ts';
import type { StagedCandidate } from '../../session-supervisor/staging/session-supervisor.ts';
import type { BootTombstone } from '../../session-supervisor/tombstone/boot-tombstone.ts';
import type { SseHub } from '../../sse/sse-hub.ts';
import { createSseHub } from '../../sse/sse-hub.ts';

/**
 * The #239 focused-test stand-ins, at the sanctioned level (the #236–#238
 * harness idiom): manual host observations (each seam a promise the test
 * settles — the observed-promise contract the Electron host lanes will
 * satisfy), journaling wrappers over the REAL landed surfaces (F2's
 * capability/binding tables, F3's hub, F4's client registry) so the
 * no-resume and no-grant legs observe the exact calls the completion
 * drives — and never a restoring one; fake candidate targets whose reaps
 * the test settles by hand; and real temp directories for the
 * tombstone-store legs (the registry-store test discipline — no mocks at
 * the file layer). No real timers anywhere.
 */

export const EPOCH = 'epoch-239';

/** Two valid, distinct project keys (26 lowercase-base32 characters, the protocol's shape). */
export const PROJECT_A: ProjectKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
export const PROJECT_B: ProjectKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';

/** The authoritative editor's document — one webContents, its first navigation. */
export const EDITOR_DOC = { webContentsId: 7, navigationId: 1 } as const;

/** Two settled session pairs — the outgoing generation 1 and the committed candidate generation 2. */
export const OLD_REF: SessionRef = { runtimeEpoch: EPOCH, generation: 1 };
export const NEW_REF: SessionRef = { runtimeEpoch: EPOCH, generation: 2 };

/** The receipt's frozen client identity — the completion's target reference (the carried input's consumption). */
export const CLIENT_IDENTITY: CompletionClientIdentity = {
  document: EDITOR_DOC,
  capability: 'supervisor-side-editor-capability',
};

/** The ordered-event journal: the order-recording seam over every observation and surface call. */
export type Journal = string[];

// ——— the manual host observations (the observed-promise seams) ———

/** One observed-promise seam: the call journals, the test settles observed-or-failed. */
interface ManualSeam {
  readonly call: () => Promise<void>;
  readonly settle: (observed: boolean) => void;
}

function manualSeam(journal: Journal, mark: string): ManualSeam {
  const pending: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = [];
  return {
    call: () => {
      journal.push(mark);
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    settle: (observed) => {
      for (const waiter of pending.splice(0)) {
        if (observed) waiter.resolve();
        else waiter.reject(new Error('the host observed the failure'));
      }
    },
  };
}

/** The three host observations, manual and journaled — settle(true) observes, settle(false) fails. */
export interface ManualObservations extends HostCompletionObservations {
  settleMainFrame(observed: boolean): void;
  settleLauncher(observed: boolean): void;
  settleTargetClosed(observed: boolean): void;
}

export function manualObservations(journal: Journal): ManualObservations {
  const mainFrame = manualSeam(journal, 'observe:main-frame-ready');
  const launcher = manualSeam(journal, 'observe:launcher-ready');
  const targetClosed = manualSeam(journal, 'observe:target-closed');
  return {
    mainFrameReady: mainFrame.call,
    launcherReady: launcher.call,
    targetClosed: targetClosed.call,
    settleMainFrame: mainFrame.settle,
    settleLauncher: launcher.settle,
    settleTargetClosed: targetClosed.settle,
  };
}

// ——— the journaling surfaces over the REAL landed tables ———

/** The failure-report hook's record — what the composition's snapshot seam received, in order. */
export interface CompletionFixture {
  readonly clients: SessionClients;
  readonly httpBindings: ClientBindings;
  readonly capabilityGrants: HostCapabilityGrants;
  readonly hub: SseHub;
  /** The fake D4 surface's grant eviction (the revocation pass's grants step). */
  readonly grants: { revokeSession(sessionRef: SessionRef): number };
  readonly journal: Journal;
  /** Every failure the reportFailedNoActive hook received, in order. */
  readonly reported: SessionFailure[];
  /** The fake D4 surface's per-session live-grant counts (the eviction's return). */
  readonly liveGrants: Map<string, number>;
}

/** Builds the journaling composition: the real F2/F3/F4 surfaces, wrapped for order. */
export function completionFixture(): CompletionFixture {
  const journal: Journal = [];
  const reported: SessionFailure[] = [];
  const liveGrants = new Map<string, number>();
  const realClients = createSessionClients();
  const realHttpBindings = createClientBindings();
  const realGrants = createHostCapabilityGrants();
  const realHub = createSseHub();

  const clients: SessionClients = {
    bind: (input) => {
      journal.push('clients:bind');
      return realClients.bind(input);
    },
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
    bind: (input) => {
      journal.push('http-bindings:bind');
      return realHttpBindings.bind(input);
    },
    unbind: (capability) => {
      journal.push('http-bindings:unbind');
      return realHttpBindings.unbind(capability);
    },
    resolve: (presented) => realHttpBindings.resolve(presented),
    counts: () => realHttpBindings.counts(),
  };
  const capabilityGrants: HostCapabilityGrants = {
    mint: (target) => {
      journal.push('host-capability:mint');
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
      journal.push('edit-grants:revokeSession');
      const evicted = liveGrants.get(`${sessionRef.runtimeEpoch}#${sessionRef.generation}`) ?? 0;
      liveGrants.delete(`${sessionRef.runtimeEpoch}#${sessionRef.generation}`);
      return evicted;
    },
  };

  return {
    clients,
    httpBindings,
    capabilityGrants,
    hub,
    grants: grantSurface,
    journal,
    reported,
    liveGrants,
  };
}

// ——— the fake granted candidate (the aftermath's reap seam) ———

/** The fake origin-lease slice the candidate's ordered revocation drives (the #238 idiom). */
export interface FakeLease {
  readonly routes: {
    revoke(): Promise<{ outcome: 'complete' | 'incomplete'; destroyedSockets: number }>;
  };
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
    routes: {
      revoke: async () => {
        revocations += 1;
        journal.push(mark);
        return { outcome, destroyedSockets: 1 };
      },
    },
  };
}

/** The granted candidate as the failure aftermath sees it — its reap settles by hand. */
export interface FakeCandidate {
  readonly target: GrantedCandidateTarget;
  settleClose(report: SupervisionCloseReport): void;
  /** Makes the next stopRun reject — the convergence leg (the E8 stop law's belt). */
  refuseClose(): void;
  readonly stopCalls: number;
}

export function fakeCandidate(
  journal: Journal,
  session: SessionRef,
  projectKey: ProjectKey,
  clientCapability: string,
): FakeCandidate {
  let stopCalls = 0;
  let settle: (report: SupervisionCloseReport) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  return {
    target: {
      session,
      host: { host: 'project', projectKey },
      routes: fakeLease(journal, 'candidate-routes:revoke').routes,
      clientCapability,
      stopRun: () => {
        stopCalls += 1;
        journal.push('candidate:stop-run');
        return new Promise<SupervisionCloseReport>((resolve, refusal) => {
          settle = resolve;
          reject = refusal;
        });
      },
    },
    settleClose: (report) => {
      settle(report);
    },
    refuseClose: () => {
      reject(new Error('the reap seam was lost'));
    },
    get stopCalls() {
      return stopCalls;
    },
  };
}

// ——— the fake staged candidate (the incomplete-reap rollback seam, F4's surface) ———

export type RollbackReason = 'cancelled' | 'drain-conflict' | 'drain-timeout' | 'incomplete-reap';

/** The staged candidate the incomplete-reap aftermath rolls back — journaled, settled by hand. */
export interface FakeStaged {
  readonly candidate: StagedCandidate;
  readonly rollbacks: readonly RollbackReason[];
  settleRollback(report: SupervisionCloseReport): void;
  refuseRollback(): void;
}

export function fakeStaged(journal: Journal, ref: SessionRef): FakeStaged {
  const rollbacks: RollbackReason[] = [];
  let settle: (report: SupervisionCloseReport) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const candidate: StagedCandidate = {
    ref,
    commit: () => Promise.reject(new Error('the staged candidate is settled')),
    rollback: (reason) => {
      journal.push('candidate:rollback');
      rollbacks.push(reason);
      return new Promise<SupervisionCloseReport>((resolve, refusal) => {
        settle = resolve;
        reject = refusal;
      });
    },
  };
  return {
    candidate,
    rollbacks,
    settleRollback: (report) => {
      settle(report);
    },
    refuseRollback: () => {
      reject(new Error('the candidate machine had already settled'));
    },
  };
}

// ——— the recording tombstone recorder (the driver's durable half, faked for order legs) ———

/** The recording stand-in for the boot-tombstone machine's recorder facet. */
export interface RecordingTombstones {
  readonly tombstones: Pick<BootTombstone, 'recordIncompleteReap'>;
  readonly records: ReadonlyArray<{
    readonly projectKey: ProjectKey;
    readonly recordedPid: number | null;
    readonly closeReport: SupervisionCloseReport | null;
  }>;
}

export function recordingTombstones(journal: Journal): RecordingTombstones {
  const records: Array<{
    projectKey: ProjectKey;
    recordedPid: number | null;
    closeReport: SupervisionCloseReport | null;
  }> = [];
  return {
    tombstones: {
      recordIncompleteReap: async (record) => {
        journal.push('tombstone:record');
        records.push(record);
      },
    },
    records,
  };
}

// ——— the real temp-directory helpers (the tombstone-store legs) ———

const scratchDirs: string[] = [];

/** A temp directory standing in for the private state directory (the registry-store test discipline). */
export async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astroix-tombstone-'));
  scratchDirs.push(dir);
  return dir;
}

export async function cleanupScratch(): Promise<void> {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** A boring complete close report — tests override fields as needed (the #238 idiom). */
export function completeCloseReport(
  reason: SupervisionCloseReport['reason'],
): SupervisionCloseReport {
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

/** An incomplete close report — the unobserved-reap accounting shape (#326's honest shape). */
export function incompleteCloseReport(
  reason: SupervisionCloseReport['reason'],
): SupervisionCloseReport {
  return {
    reason,
    outcome: 'incomplete',
    failures: ['worker-reap', 'managed-astro-reap'],
    accounting: {
      workerReportReceived: false,
      workerCleanupComplete: false,
      workerReaped: false,
      managedAstroReaped: false,
      probesSettled: true,
      killEscalations: ['worker', 'managed-astro'],
    },
  };
}

// ——— the completion driver over the fixture (the shared wiring) ———

/** The driver wiring both completion test files share: the journaling surfaces + the recording hook. */
export function completionDriver(
  fx: CompletionFixture,
  tombstones: Pick<BootTombstone, 'recordIncompleteReap'>,
): SessionCompletion {
  return createSessionCompletion({
    clients: fx.clients,
    httpBindings: fx.httpBindings,
    hostCapabilities: fx.capabilityGrants,
    streams: fx.hub,
    grants: fx.grants,
    reportFailedNoActive: (failure) => {
      fx.journal.push('report:failed-no-active');
      fx.reported.push(failure);
    },
    tombstones,
  });
}

/** A clean settled revocation report — the input shape F6's coordinator hands the completion. */
export function cleanRevocation(session: SessionRef): RevocationReport {
  return {
    session,
    steps: [
      { step: 'streams', result: { kind: 'streams-ended', ended: 0 } },
      { step: 'routes', result: { kind: 'lease-revoked', lease: 'complete', destroyedSockets: 0 } },
      { step: 'edit-grants', result: { kind: 'grants-evicted', evicted: 0 } },
      { step: 'client-bindings', result: { kind: 'bindings-revoked' } },
      { step: 'host-capability', result: { kind: 'capability-revoked' } },
    ],
    outcome: 'complete',
  };
}

// ——— the manual lease probe (the D3 exclusive-acquisition seam) ———

/** The exclusive edit-writer-lease probe, manual: the test sets what the next acquisition proves. */
export interface ManualLeaseProbe {
  readonly acquire: () => Promise<{ readonly kind: 'exclusive' } | { readonly kind: 'contended' }>;
  setAnswer(answer: 'exclusive' | 'contended'): void;
  readonly probes: number;
}

export function manualLeaseProbe(initial: 'exclusive' | 'contended'): ManualLeaseProbe {
  let answer = initial;
  let probes = 0;
  return {
    acquire: async () => {
      probes += 1;
      return { kind: answer };
    },
    setAnswer: (next) => {
      answer = next;
    },
    get probes() {
      return probes;
    },
  };
}

/** One macrotask boundary — lets the driver advance past an injected seam's await (the #238 idiom). */
export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
