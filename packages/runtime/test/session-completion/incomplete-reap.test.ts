import { afterEach, describe, expect, it } from 'vitest';
import { FAILURE_MESSAGES } from '../../session-supervisor/staging/activation-attempt.ts';
import { createBootTombstone } from '../../session-supervisor/tombstone/boot-tombstone.ts';
import { openTombstoneStore } from '../../session-supervisor/tombstone/tombstone-store.ts';
import {
  cleanupScratch,
  completeCloseReport,
  completionDriver,
  completionFixture,
  fakeStaged,
  flushMicrotasks,
  incompleteCloseReport,
  makeStateDir,
  manualLeaseProbe,
  NEW_REF,
  PROJECT_A,
  recordingTombstones,
} from './completion-harness.ts';

/**
 * The #239 focused tests, part 3 — the incomplete forced reap's aftermath
 * (ADR-0006 §4 step 4's tail): F6's `prepareForced` returned
 * `incomplete-reap` (the two-second deadline ran out unobserved, no
 * receipt exists), and THIS lane owns what follows, in the ADR's order:
 * atomically persist the boot-scoped tombstone, grant no new session
 * authority, roll back any candidate under F4's `incomplete-reap`
 * reason, and enter the blocked no-active state. The composition leg
 * wires the REAL boot-tombstone machine and proves the same-boot
 * relaunch denial end to end.
 */

afterEach(async () => {
  await cleanupScratch();
});

describe('the §4 step 4 order: tombstone first, rollback, then the blocked no-active state', () => {
  it('persists the tombstone BEFORE rolling the candidate back, then reports the blocked state', async () => {
    const fx = completionFixture();
    const tombs = recordingTombstones(fx.journal);
    const completion = completionDriver(fx, tombs.tombstones);
    const staged = fakeStaged(fx.journal, NEW_REF);

    const pending = completion.handleIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: 4242,
      closeReport: incompleteCloseReport('stopped'),
      candidate: staged.candidate,
    });
    await flushMicrotasks(); // the recorder resolves; the rollback call happens
    const rollbackReport = completeCloseReport('stopped');
    staged.settleRollback(rollbackReport);
    const outcome = await pending;

    expect(outcome).toEqual({
      kind: 'blocked-no-active',
      failure: { category: 'incomplete-reap', message: FAILURE_MESSAGES['incomplete-reap'] },
      tombstonePersisted: true,
      rollback: rollbackReport,
    });
    // The ADR's order, exactly — a crash after the first mark leaves the tombstone standing.
    expect(fx.journal).toEqual([
      'tombstone:record',
      'candidate:rollback',
      'report:failed-no-active',
    ]);
    expect(staged.rollbacks).toEqual(['incomplete-reap']); // F4's reason of the same name
    expect(tombs.records).toEqual([
      {
        projectKey: PROJECT_A,
        recordedPid: 4242,
        closeReport: incompleteCloseReport('stopped'),
      },
    ]);
    expect(fx.reported).toEqual([
      { category: 'incomplete-reap', message: FAILURE_MESSAGES['incomplete-reap'] },
    ]);
  });

  it('a deactivation force path has no candidate — the tombstone still stands, the blocked state still entered', async () => {
    const fx = completionFixture();
    const tombs = recordingTombstones(fx.journal);
    const completion = completionDriver(fx, tombs.tombstones);

    const outcome = await completion.handleIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: null,
      closeReport: null,
      candidate: null,
    });

    expect(outcome).toEqual({
      kind: 'blocked-no-active',
      failure: { category: 'incomplete-reap', message: FAILURE_MESSAGES['incomplete-reap'] },
      tombstonePersisted: true,
      rollback: null,
    });
    expect(fx.journal).toEqual(['tombstone:record', 'report:failed-no-active']);
    expect(tombs.records).toEqual([
      { projectKey: PROJECT_A, recordedPid: null, closeReport: null },
    ]);
  });

  it('a refusing rollback converges: no fabricated report, the blocked state still reported', async () => {
    const fx = completionFixture();
    const tombs = recordingTombstones(fx.journal);
    const completion = completionDriver(fx, tombs.tombstones);
    const staged = fakeStaged(fx.journal, NEW_REF);

    const pending = completion.handleIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: null,
      closeReport: null,
      candidate: staged.candidate,
    });
    await flushMicrotasks();
    staged.refuseRollback(); // the candidate's own machine had already settled it
    const outcome = await pending;

    expect(outcome.rollback).toBe(null);
    expect(outcome.kind).toBe('blocked-no-active');
    expect(fx.reported).toEqual([
      { category: 'incomplete-reap', message: FAILURE_MESSAGES['incomplete-reap'] },
    ]);
  });

  it('grants no authority anywhere in the path — no mint, no bind, only the tombstone, the rollback, and the report', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);

    await completion.handleIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: null,
      closeReport: null,
      candidate: null,
    });

    expect(fx.journal.some((entry) => entry.endsWith(':mint') || entry.endsWith(':bind'))).toBe(
      false,
    );
    expect(fx.capabilityGrants.current({ host: 'project', projectKey: PROJECT_A })).toBe(null);
    expect(fx.clients.counts()).toEqual({ editor: 0, diagnostic: 0 });
  });
});

describe('the composition leg — the REAL boot-tombstone machine behind the aftermath', () => {
  it('the aftermath tombstone blocks the same-boot relaunch (the §8 denial, end to end)', async () => {
    const fx = completionFixture();
    const dir = await makeStateDir();
    const store = await openTombstoneStore(dir);
    const probe = manualLeaseProbe('contended');
    const machine = createBootTombstone({
      store,
      bootScope: 'boot-1',
      acquireExclusiveEditLease: probe.acquire,
    });
    const completion = completionDriver(fx, machine);

    const outcome = await completion.handleIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: 4242,
      closeReport: incompleteCloseReport('stopped'),
      candidate: null,
    });
    expect(outcome.tombstonePersisted).toBe(true);

    // The relaunch attempt on the SAME machine boot: denied.
    expect(await machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'incomplete-cleanup-tombstone',
    });

    // And the lease-proven recovery reopens activation through the same
    // real machine the aftermath persisted into.
    probe.setAnswer('exclusive');
    expect(await machine.recoverByLeaseProof()).toEqual({ kind: 'recovered' });
    expect(await machine.admitActivation()).toEqual({
      kind: 'admitted',
      clearedStaleTombstone: false,
    });
  });
});
