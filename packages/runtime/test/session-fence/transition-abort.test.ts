import {
  type SessionRef,
  sessionLabel,
  sessionSnapshotSchema,
} from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { createHostCapabilityGrants } from '../../api/http/host-capability.ts';
import { writeFailure, writeRejection } from '../../edit-authority/executor/write-outcomes.ts';
import { sha256Hex } from '../../edit-authority/grants/canonical-bounds.ts';
import type { SessionClients } from '../../session-supervisor/clients/session-clients.ts';
import { createSessionClients } from '../../session-supervisor/clients/session-clients.ts';
import type { DrainReport } from '../../session-supervisor/fence/drain-report.ts';
import { createEditFence, type EditFence } from '../../session-supervisor/fence/edit-fence.ts';
import {
  type ActivationAttempt,
  createSessionSupervisor,
  FAILURE_MESSAGES,
  type SessionSupervisor,
  type StagedCandidate,
  type StartCandidateRun,
} from '../../session-supervisor/staging/session-supervisor.ts';
import {
  type ControlledEdit,
  completeReport,
  controlledEdit,
  itemAt,
  type ManualClock,
  manualClock,
  PROJECT_A,
  PROJECT_B,
  type SlimRun,
  slimRun,
} from './fence-harness.ts';

/**
 * The #237 focused tests, part 3 — the transition composition: the
 * fence's verdicts driving F4's real staged-activation machine over the
 * real supervisor (read-only composition; `staging/**` untouched). The
 * legs prove the ticket's abort laws at the boundary they were chartered
 * on: a drain conflict or failure aborts the ordinary replacement
 * through candidate rollback while the old session's authority —
 * snapshot, host capability, editor binding, run — remains unrevoked; a
 * drain timeout aborts the same way but keeps the old editor fenced
 * until its accepted work turns terminal; a pre-revocation cancellation
 * lets the drain finish and resumes only on terminality; and a clean
 * drain leaves the authority decision to F6 untouched. Revocation
 * ordering, receipts, and force are F6's (#238) — nothing here revokes.
 */

const EPOCH = 'epoch-237';

/** One editor document the old session's authoritative client is bound at. */
const DOCUMENT = { webContentsId: 7, navigationId: 1 } as const;

interface Fixture {
  readonly supervisor: SessionSupervisor;
  readonly clients: SessionClients;
  readonly grants: ReturnType<typeof createHostCapabilityGrants>;
  readonly fence: EditFence;
  readonly clock: ManualClock;
  readonly runs: SlimRun[];
  readonly startCandidate: StartCandidateRun;
}

function fixture(): Fixture {
  const clients = createSessionClients();
  const grants = createHostCapabilityGrants();
  const runs: SlimRun[] = [];
  const startCandidate: StartCandidateRun = () => {
    const run = slimRun();
    runs.push(run);
    return run.run;
  };
  const supervisor = createSessionSupervisor({
    startCandidate,
    runtimeEpoch: EPOCH,
    clients,
    hostCapabilities: grants,
  });
  const clock = manualClock();
  const fence = createEditFence({ clock: clock.clock });
  return { supervisor, clients, grants, fence, clock, runs, startCandidate };
}

/** The begun attempt, or a thrown expectation when it was refused. */
function begun(result: ReturnType<SessionSupervisor['begin']>): ActivationAttempt {
  if (result.kind !== 'begun')
    throw new Error(`expected the attempt to be admitted: ${result.reason}`);
  return result.attempt;
}

/** The one committed, authority-bearing session the abort legs must preserve. */
interface OldSession {
  readonly ref: SessionRef;
  readonly run: SlimRun;
  readonly capability: string;
}

/** Commits the first generation as the active session and binds its authoritative editor. */
async function activeSession(fx: Fixture): Promise<OldSession> {
  const attempt = begun(fx.supervisor.begin(PROJECT_A));
  const run = itemAt(fx.runs, 0);
  run.settleReady();
  const candidate = await attempt.ready;
  await candidate.commit();
  const ref: SessionRef = { runtimeEpoch: EPOCH, generation: 1 };
  const bound = fx.clients.bind({ role: 'editor', document: DOCUMENT, sessionRef: ref });
  if (bound.kind !== 'bound') throw new Error('expected the editor binding to be admitted');
  return { ref, run, capability: bound.capability };
}

/** Begins the staged switch attempt (generation 2, project B) with a readied candidate. */
async function stagedSwitch(
  fx: Fixture,
): Promise<{ attempt: ActivationAttempt; candidate: StagedCandidate }> {
  const attempt = begun(fx.supervisor.begin(PROJECT_B));
  const run = itemAt(fx.runs, fx.runs.length - 1);
  run.settleReady();
  const candidate = await attempt.ready;
  return { attempt, candidate };
}

/** Rolls back a staged candidate, converging its fake run's close report. */
async function rollbackCandidate(
  fx: Fixture,
  candidate: StagedCandidate,
  reason: 'drain-conflict' | 'drain-timeout',
): Promise<void> {
  const rollback = candidate.rollback(reason);
  itemAt(fx.runs, 1).closeWith(completeReport('stopped'));
  await rollback;
}

/**
 * The old-authority proof — the ticket's "old authority remains valid
 * before revocation": the snapshot still names the old session ready
 * (the §4 law — a staged failure beside it is a notification, never
 * the global state), its run was never stopped, its project host
 * capability still verifies, and its editor binding still authorizes
 * for the exact pair.
 */
function expectOldAuthorityIntact(fx: Fixture, old: OldSession): void {
  const snapshot = fx.supervisor.snapshot();
  expect(snapshot.active).toEqual({ ref: old.ref, projectKey: PROJECT_A, state: 'ready' });
  expect(sessionSnapshotSchema.parse(snapshot)).toBeTruthy();
  expect(sessionLabel(snapshot)).toBe('ready');
  expect(old.run.stopCalls).toBe(0);
  expect(
    fx.grants.verify(fx.grants.current({ host: 'project', projectKey: PROJECT_A }) ?? undefined, {
      host: 'project',
      projectKey: PROJECT_A,
    }),
  ).toBe(true);
  expect(
    fx.clients.authorize({
      capability: old.capability,
      document: DOCUMENT,
      sessionRef: old.ref,
      role: 'editor',
    }),
  ).toEqual({ kind: 'authorized', role: 'editor' });
}

/** Commits one committed outcome for the queue seam. */
function committed() {
  return { type: 'committed' as const, revision: sha256Hex(new TextEncoder().encode('landed')) };
}

/** Fences the old session's edit pipeline with one accepted edit and two pending debounces. */
function fenceForDrain(
  fx: Fixture,
  settled: (edits: ControlledEdit[]) => void,
): Promise<DrainReport> {
  const accepted = controlledEdit('entry');
  const pendingA = controlledEdit('style-a');
  const pendingB = controlledEdit('style-b');
  const submission = fx.fence.submit(accepted.edit);
  if (submission.kind !== 'accepted') throw new Error('expected admission while open');
  const start = fx.fence.fence(() => [pendingA.edit, pendingB.edit]);
  if (start.kind !== 'fenced') throw new Error(`expected the fence to begin: ${start.reason}`);
  settled([accepted, pendingA, pendingB]);
  return start.drain.outcome;
}

describe('transition abort — conflict and write failure (ADR-0006 §4 step 3)', () => {
  it('a drain conflict aborts through candidate rollback with old authority unrevoked, then resumes the old editor', async () => {
    const fx = fixture();
    const old = await activeSession(fx);
    const { candidate } = await stagedSwitch(fx);

    const outcome = fenceForDrain(fx, (edits) => {
      itemAt(edits, 0).settle(committed());
      itemAt(edits, 1).settle(committed());
      itemAt(edits, 2).settle(writeRejection('changed-baseline'));
    });
    const report = await outcome;
    expect(report).toMatchObject({ kind: 'failed', rollbackReason: 'drain-conflict' });
    if (report.kind !== 'failed') return;

    // the ordinary replacement aborts: the candidate rolls back under the
    // report's own reason, and everything the old session owns survives
    await rollbackCandidate(fx, candidate, report.rollbackReason);
    expect(fx.supervisor.snapshot().lastFailure).toEqual({
      category: 'drain-conflict',
      message: FAILURE_MESSAGES['drain-conflict'],
    });
    expectOldAuthorityIntact(fx, old);

    // ...and the drained old editor resumes — all accepted work was terminal
    expect(fx.fence.state).toBe('failed');
    expect(fx.fence.fence()).toMatchObject({ kind: 'refused' });
  });

  it('a write failure aborts identically — one abort path for both write-surface causes', async () => {
    const fx = fixture();
    const old = await activeSession(fx);
    const { candidate } = await stagedSwitch(fx);

    const report = await fenceForDrain(fx, (edits) => {
      itemAt(edits, 0).settle(committed());
      itemAt(edits, 1).settle(writeFailure('replace-failed'));
      itemAt(edits, 2).settle(committed());
    });
    expect(report).toMatchObject({ kind: 'failed', cause: 'write-failure' });
    if (report.kind !== 'failed') return;

    await rollbackCandidate(fx, candidate, report.rollbackReason);
    expect(fx.supervisor.snapshot().lastFailure).toEqual({
      category: 'drain-conflict',
      message: FAILURE_MESSAGES['drain-conflict'],
    });
    expectOldAuthorityIntact(fx, old);
  });
});

describe('transition abort — drain timeout (ADR-0006 §4 step 3/4, the no-silent-work law)', () => {
  it('a timeout aborts the switch but the old editor stays fenced until its accepted work is terminal', async () => {
    const fx = fixture();
    const old = await activeSession(fx);
    const { candidate } = await stagedSwitch(fx);

    const accepted = controlledEdit('entry');
    const submission = fx.fence.submit(accepted.edit);
    expect(submission.kind).toBe('accepted');
    const start = fx.fence.fence(() => []);
    expect(start.kind).toBe('fenced');
    if (start.kind !== 'fenced') return;

    fx.clock.fireDeadline();
    const report = await start.drain.outcome;
    expect(report).toMatchObject({ kind: 'timed-out', rollbackReason: 'drain-timeout' });
    // the timeout alone disturbed nothing: authority is intact and the
    // supervisor records no failure until the coordinator rolls back
    expectOldAuthorityIntact(fx, old);
    expect(fx.supervisor.snapshot().lastFailure).toBeUndefined();

    await rollbackCandidate(fx, candidate, 'drain-timeout');
    expect(fx.supervisor.snapshot().lastFailure).toEqual({
      category: 'drain-timeout',
      message: FAILURE_MESSAGES['drain-timeout'],
    });
    expectOldAuthorityIntact(fx, old);

    // the timed-out fence does not resume merely because the transition
    // was aborted — the accepted work is still unsettled
    expect(start.drain.resume()).toEqual({ kind: 'refused', reason: 'work-not-terminal' });
    expect(fx.fence.submit(controlledEdit('late').edit)).toEqual({ kind: 'refused' });

    // ...and when the work finally turns terminal, the resume window opens
    accepted.settle(committed());
    await start.drain.settled;
    expect(fx.fence.state).toBe('terminal-after-timeout');
    expect(start.drain.resume()).toEqual({ kind: 'resumed' });
    expectOldAuthorityIntact(fx, old);
  });
});

describe('safe pre-revocation cancellation — the drain outlives the cancelled switch', () => {
  it('cancelling the switch mid-drain lets the drain finish; resume follows terminality, not cancellation', async () => {
    const fx = fixture();
    const old = await activeSession(fx);
    const { attempt } = await stagedSwitch(fx);

    const accepted = controlledEdit('entry');
    const pending = controlledEdit('style');
    expect(fx.fence.submit(accepted.edit).kind).toBe('accepted');
    const start = fx.fence.fence(() => [pending.edit]);
    expect(start.kind).toBe('fenced');
    if (start.kind !== 'fenced') return;

    // the coordinator cancels the switch before any revocation: the F4
    // attempt cancels legally, and the accepted work keeps settling
    const cancelled = attempt.cancel('user');
    itemAt(fx.runs, 1).closeWith(completeReport('cancelled'));
    await cancelled;
    expect(fx.fence.state).toBe('draining');

    accepted.settle(committed());
    pending.settle(committed());
    const report = await start.drain.outcome;
    expect(report).toEqual({ kind: 'drained', settled: 2 });
    expect(start.drain.resume()).toEqual({ kind: 'resumed' });

    // a cancelled attempt records no failure; the old session never moved
    const snapshot = fx.supervisor.snapshot();
    expect(snapshot.lastFailure).toBeUndefined();
    expectOldAuthorityIntact(fx, old);
    expect(fx.fence.submit(controlledEdit('resumed-edit').edit).kind).toBe('accepted');
  });
});

describe('a clean drain leaves the transition to its owner (F6)', () => {
  it('a terminal clean report disturbs nothing — no rollback, no failure, authority where it was', async () => {
    const fx = fixture();
    const old = await activeSession(fx);
    await stagedSwitch(fx);

    const report = await fenceForDrain(fx, (edits) => {
      for (const edit of edits) edit.settle(committed());
    });
    expect(report).toEqual({ kind: 'drained', settled: 3 });
    expect(fx.fence.state).toBe('drained');

    // the candidate stays staged and nothing was recorded: consuming the
    // terminal report (the receipt, the commit) is F6's composition
    expect(fx.supervisor.snapshot().attempt?.state).toBe('starting');
    expect(fx.supervisor.snapshot().lastFailure).toBeUndefined();
    expect(itemAt(fx.runs, 1).stopCalls).toBe(0);
    expectOldAuthorityIntact(fx, old);
  });
});
