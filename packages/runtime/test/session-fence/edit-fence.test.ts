import { describe, expect, it, vi } from 'vitest';
import { writeFailure, writeRejection } from '../../edit-authority/executor/write-outcomes.ts';
import {
  DRAIN_DEADLINE_MS,
  type DrainReport,
} from '../../session-supervisor/fence/drain-report.ts';
import {
  createEditFence,
  type EditDrain,
  type EditFence,
  type QueuedEdit,
} from '../../session-supervisor/fence/edit-fence.ts';
import {
  committed,
  controlledEdit,
  flush,
  itemAt,
  manualClock,
  settlementOf,
} from './fence-harness.ts';

/**
 * The #237 focused tests, part 1 — the fence machine itself: synchronous
 * admission closure with the pending-debounce flush, the one serialized
 * queue, the terminal verdicts (drained / failed / timed-out), the
 * five-second deadline on both sides, the no-silent-work law after a
 * timeout, and the resume legality window at every edge.
 */

/** The begun drain of a fence over the given pending flush, or a thrown expectation when refused. */
function begunFence(fence: EditFence, pending: () => Iterable<QueuedEdit> = () => []): EditDrain {
  const start = fence.fence(pending);
  if (start.kind !== 'fenced') throw new Error(`expected the fence to begin: ${start.reason}`);
  return start.drain;
}

describe('admission and the one serialized queue', () => {
  it('admits while open and executes strictly in admission order — one in flight', async () => {
    const fence = createEditFence();
    const first = controlledEdit('entry');
    const second = controlledEdit('style');

    const firstSubmission = fence.submit(first.edit);
    if (firstSubmission.kind !== 'accepted') throw new Error('expected admission while open');
    // the pump starts synchronously: the first edit executes immediately,
    // and the second waits for it — strict serialization
    expect(first.calls()).toBe(1);
    const secondSubmission = fence.submit(second.edit);
    if (secondSubmission.kind !== 'accepted') throw new Error('expected admission while open');
    expect(second.calls()).toBe(0);

    first.settle(committed());
    expect(await firstSubmission.outcome).toBe('success');
    await flush();
    expect(second.calls()).toBe(1);
    second.settle(committed());
    expect(await secondSubmission.outcome).toBe('success');
    expect(fence.state).toBe('open');
  });

  it('fence() closes admission synchronously and runs the pending flush inside the call', () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const flushOrder: string[] = [];
    const pending = controlledEdit('style-pending');
    const pre = controlledEdit('entry');
    expect(fence.submit(pre.edit).kind).toBe('accepted');

    const start = fence.fence(() => {
      flushOrder.push('flush-ran');
      return [pending.edit];
    });
    expect(start.kind).toBe('fenced');
    // synchronous, before any await: closure + flush both inside fence()
    expect(flushOrder).toEqual(['flush-ran']);
    expect(fence.state).toBe('draining');
    // new editor input is refused the instant the fence returned
    expect(fence.submit(controlledEdit('late').edit)).toEqual({ kind: 'refused' });
    // the pre-fence edit is already executing; the flushed one follows it
    expect(pre.calls()).toBe(1);
  });

  it('a throwing flush seam leaves the fence open — the transition never began', () => {
    const fence = createEditFence({ clock: manualClock().clock });
    expect(() =>
      fence.fence(() => {
        throw new Error('client seam defect');
      }),
    ).toThrow('client seam defect');
    expect(fence.state).toBe('open');
    expect(fence.submit(controlledEdit('after').edit).kind).toBe('accepted');
  });

  it('a re-entrant fence() from inside the pending seam hits the closed admission — no hung inner drain', () => {
    const fence = createEditFence({ clock: manualClock().clock });
    let inner: ReturnType<typeof fence.fence> | undefined;
    const drain = fence.fence(() => {
      inner = fence.fence(() => []);
      return [controlledEdit('flushed').edit];
    });
    // admission closed before the flush materialized: the inner call is
    // refused, never a second drain whose outcome nobody settles
    expect(inner).toEqual({ kind: 'refused', reason: 'not-open' });
    expect(drain.kind).toBe('fenced');
  });

  it('fence() refuses while a drain is live — one drain, not a second behind it', () => {
    const fence = createEditFence({ clock: manualClock().clock });
    expect(fence.fence().kind).toBe('fenced');
    expect(fence.fence()).toEqual({ kind: 'refused', reason: 'not-open' });
  });

  it('a drain with no accepted work is immediately drained — settled 0', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const drain = begunFence(fence);
    expect(fence.state).toBe('drained');
    expect(await drain.outcome).toEqual({ kind: 'drained', settled: 0 });
    await expect(drain.settled).resolves.toBeUndefined();
  });
});

describe('the one drain waits for every accepted operation — flush included', () => {
  it('pending debounces share the one deadline and verdict: no separate client and server drains', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const preAccepted = controlledEdit('entry');
    const pendingA = controlledEdit('style-a');
    const pendingB = controlledEdit('style-b');
    expect(fence.submit(preAccepted.edit).kind).toBe('accepted');

    const drain = begunFence(fence, () => [pendingA.edit, pendingB.edit]);

    // one deadline for the whole sealed ledger — pre-accepted and flushed alike
    preAccepted.settle(committed());
    pendingA.settle(committed());
    await flush();
    expect(fence.state).toBe('draining');
    expect(await settlementOf(drain.outcome)).toBe('pending');

    pendingB.settle(committed());
    expect(await drain.outcome).toEqual({ kind: 'drained', settled: 3 });
    expect(fence.state).toBe('drained');
  });

  it('the drain settles accepted writes once, in admission order', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const order: string[] = [];
    const edits = (['entry', 'style-a', 'style-b'] as const).map((key) => ({
      key,
      edit: controlledEdit(key),
    }));
    // the queue seam records its own execution order
    const queued = edits.map(({ key, edit }) => ({
      key,
      edit: {
        key,
        execute: () => {
          order.push(`start:${key}`);
          return edit.edit.execute().then((outcome) => {
            order.push(`end:${key}`);
            return outcome;
          });
        },
      },
    }));
    expect(fence.submit(itemAt(queued, 0).edit).kind).toBe('accepted');
    const drain = begunFence(fence, () => [itemAt(queued, 1).edit, itemAt(queued, 2).edit]);

    itemAt(edits, 0).edit.settle(committed());
    await flush();
    itemAt(edits, 1).edit.settle(committed());
    await flush();
    itemAt(edits, 2).edit.settle(committed());
    await flush();

    expect(order).toEqual([
      'start:entry',
      'end:entry',
      'start:style-a',
      'end:style-a',
      'start:style-b',
      'end:style-b',
    ]);
    expect(await drain.outcome).toEqual({ kind: 'drained', settled: 3 });
  });
});

describe('terminal verdicts — conflict and write failure abort, everything still settles', () => {
  it('a revision conflict fails the drain and names the first failing key', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const clean = controlledEdit('entry');
    const conflicted = controlledEdit('style');
    const drain = begunFence(fence, () => [clean.edit, conflicted.edit]);

    const conflict = writeRejection('changed-baseline');
    clean.settle(committed());
    conflicted.settle(conflict);
    const report = await drain.outcome;
    expect(report).toEqual({
      kind: 'failed',
      cause: 'conflict',
      firstFailure: { key: 'style', cause: 'conflict', outcome: conflict },
      settled: 2,
      failure: {
        category: 'drain-conflict',
        message: 'the outgoing session reported a write conflict while draining',
      },
      rollbackReason: 'drain-conflict',
    });
    expect(fence.state).toBe('failed');
    await expect(drain.settled).resolves.toBeUndefined();
  });

  it('the expected-absent species (target-exists) is a conflict too', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const edit = controlledEdit('entry');
    const drain = begunFence(fence, () => [edit.edit]);
    edit.settle(writeRejection('target-exists'));
    expect((await drain.outcome).kind).toBe('failed');
    expect(fence.state).toBe('failed');
  });

  it('a write failure fails the drain under the same abort path', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const edit = controlledEdit('entry');
    const drain = begunFence(fence, () => [edit.edit]);
    const failure = writeFailure('replace-failed');
    edit.settle(failure);
    const report = await drain.outcome;
    expect(report).toMatchObject({
      kind: 'failed',
      cause: 'write-failure',
      firstFailure: { key: 'entry', outcome: failure },
      rollbackReason: 'drain-conflict',
    });
    expect(report.kind === 'failed' && report.failure.category).toBe('drain-conflict');
  });

  it('the first failure decides the abort report — later failures do not overwrite it', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const first = controlledEdit('entry');
    const second = controlledEdit('style');
    const drain = begunFence(fence, () => [first.edit, second.edit]);
    first.settle(writeRejection('changed-baseline'));
    await flush();
    second.settle(writeFailure('write-failed'));
    const report = await drain.outcome;
    expect(report.kind).toBe('failed');
    if (report.kind === 'failed') {
      expect(report.firstFailure.key).toBe('entry');
      expect(report.cause).toBe('conflict');
    }
    expect(fence.state).toBe('failed');
  });

  it('a failure that settled before the fence still fails the sealed drain (fail-closed verdict)', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const conflicted = controlledEdit('entry');
    const submission = fence.submit(conflicted.edit);
    if (submission.kind !== 'accepted') throw new Error('expected admission while open');
    conflicted.settle(writeRejection('changed-baseline'));
    expect(await submission.outcome).toBe('conflict');

    const drain = begunFence(fence);
    // the editor already saw the conflict through its submission outcome;
    // the drain still answers the ADR's plain question honestly — a
    // conflict among accepted operations aborts the transition
    expect(await drain.outcome).toMatchObject({ kind: 'failed', settled: 1 });
    expect(fence.state).toBe('failed');
  });

  it('a rejecting queue seam converges honestly failed — never a hung drain', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const edit = controlledEdit('entry');
    const drain = begunFence(fence, () => [edit.edit]);
    edit.fail();
    expect(await drain.outcome).toMatchObject({ kind: 'failed', cause: 'write-failure' });
    expect(fence.state).toBe('failed');
    await expect(drain.settled).resolves.toBeUndefined();
  });

  it('every accepted operation still settles on the failed path — writes are settled once', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const conflicted = controlledEdit('entry');
    const behindIt = controlledEdit('style');
    const drain = begunFence(fence, () => [conflicted.edit, behindIt.edit]);
    conflicted.settle(writeRejection('changed-baseline'));
    await flush();
    // the queue keeps going: the operation behind the conflict executes
    expect(behindIt.calls()).toBe(1);
    behindIt.settle(committed());
    expect(await drain.outcome).toMatchObject({ kind: 'failed', settled: 2 });
    await expect(drain.settled).resolves.toBeUndefined();
  });
});

describe('the five-second deadline', () => {
  it('arms exactly the drain deadline constant, and a clean settle disarms it', async () => {
    const manual = manualClock();
    const fence = createEditFence({ clock: manual.clock });
    const edit = controlledEdit('entry');
    const drain = begunFence(fence, () => [edit.edit]);

    expect(manual.armedDelays()).toEqual([DRAIN_DEADLINE_MS]);
    expect(DRAIN_DEADLINE_MS).toBe(5000);

    edit.settle(committed());
    expect(await drain.outcome).toEqual({ kind: 'drained', settled: 1 });
    expect(manual.disarms()).toBe(1);
    // the disarmed deadline firing late is a no-op — the verdict stands —
    // and so is a sticky timer that runs despite its clear (the state
    // guard, never the disarm, is the race discipline)
    manual.fireDeadline();
    manual.firePastDisarm();
    expect(fence.state).toBe('drained');
    expect(await drain.outcome).toEqual({ kind: 'drained', settled: 1 });
  });

  it('both sides of the boundary through the host clock: 4999 ms still draining, 5000 ms times out', async () => {
    vi.useFakeTimers();
    try {
      const fence = createEditFence(); // the production host clock — fake timers intercept it
      const edit = controlledEdit('entry');
      expect(fence.submit(edit.edit).kind).toBe('accepted');
      const drain = begunFence(fence);

      let verdict: DrainReport | undefined;
      void drain.outcome.then((report) => {
        verdict = report;
      });

      await vi.advanceTimersByTimeAsync(DRAIN_DEADLINE_MS - 1);
      expect(fence.state).toBe('draining');
      expect(verdict).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      expect(fence.state).toBe('timed-out');
      expect(verdict).toMatchObject({
        kind: 'timed-out',
        settled: 0,
        pending: 1,
        failure: { category: 'drain-timeout' },
        rollbackReason: 'drain-timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a clean settle through the host clock disarms the deadline — advancing past it changes nothing', async () => {
    vi.useFakeTimers();
    try {
      const fence = createEditFence();
      const edit = controlledEdit('entry');
      const drain = begunFence(fence, () => [edit.edit]);

      edit.settle(committed());
      expect(await drain.outcome).toEqual({ kind: 'drained', settled: 1 });

      // the disarmed production timer never fires — the verdict stands
      await vi.advanceTimersByTimeAsync(DRAIN_DEADLINE_MS * 2);
      expect(fence.state).toBe('drained');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the no-silent-work law — a timed-out fence stays fenced and keeps tracking', () => {
  it('the timeout is a resolved report, admission stays closed, and resume refuses', async () => {
    const manual = manualClock();
    const fence = createEditFence({ clock: manual.clock });
    const edit = controlledEdit('entry');
    const drain = begunFence(fence, () => [edit.edit]);

    manual.fireDeadline();
    expect(await drain.outcome).toMatchObject({ kind: 'timed-out', pending: 1 });
    expect(fence.state).toBe('timed-out');

    // the caller was told, and the fence itself proves the work is not
    // lost: admission stays closed and resume refuses while work is
    // unsettled — never a timeout-only rejection with work unnoticed
    expect(fence.submit(controlledEdit('late').edit)).toEqual({ kind: 'refused' });
    expect(drain.resume()).toEqual({ kind: 'refused', reason: 'work-not-terminal' });
    expect(await settlementOf(drain.settled)).toBe('pending');
  });

  it('the queue keeps executing accepted work after the timeout — nothing goes unnoticed', async () => {
    const manual = manualClock();
    const fence = createEditFence({ clock: manual.clock });
    const inFlight = controlledEdit('entry');
    const behindIt = controlledEdit('style');
    const drain = begunFence(fence, () => [inFlight.edit, behindIt.edit]);

    manual.fireDeadline();
    expect(fence.state).toBe('timed-out');
    inFlight.settle(committed());
    await flush();
    // the pump did not stop at the verdict: the queued operation executes
    expect(behindIt.calls()).toBe(1);
    behindIt.settle(committed());
    await drain.settled;
  });

  it('late terminality opens the resume window — the verdict stays the timeout it settled with', async () => {
    const manual = manualClock();
    const fence = createEditFence({ clock: manual.clock });
    const edit = controlledEdit('entry');
    const drain = begunFence(fence, () => [edit.edit]);

    manual.fireDeadline();
    expect((await drain.outcome).kind).toBe('timed-out');

    edit.settle(committed());
    await drain.settled;
    expect(fence.state).toBe('terminal-after-timeout');
    // the report is single-settlement: F6 reads the timed-out verdict,
    // never a late rewrite
    expect(await drain.outcome).toMatchObject({ kind: 'timed-out' });
    expect(drain.resume()).toEqual({ kind: 'resumed' });
    expect(fence.state).toBe('open');
  });
});

describe('resume legality — every edge of the window', () => {
  it('a spent drain refuses not-fenced once the fence is open again', () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const drain = begunFence(fence);
    expect(drain.resume()).toEqual({ kind: 'resumed' });
    expect(drain.resume()).toEqual({ kind: 'refused', reason: 'not-fenced' });
  });

  it('refuses while the drain is in flight', () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const edit = controlledEdit('entry');
    const drain = begunFence(fence, () => [edit.edit]);
    expect(drain.resume()).toEqual({ kind: 'refused', reason: 'drain-in-flight' });
  });

  it('resume after a clean drain reopens admission and the next fence starts a fresh ledger', async () => {
    const manual = manualClock();
    const fence = createEditFence({ clock: manual.clock });
    const edit = controlledEdit('entry');
    const first = begunFence(fence, () => [edit.edit]);
    edit.settle(committed());
    await first.outcome;

    expect(first.resume()).toEqual({ kind: 'resumed' });
    const next = controlledEdit('next');
    expect(fence.submit(next.edit).kind).toBe('accepted');

    // the retry path: a second fence with its own deadline and ledger —
    // over the work admitted since the resume, and nothing older
    const second = begunFence(fence);
    expect(manual.armedDelays()).toEqual([DRAIN_DEADLINE_MS, DRAIN_DEADLINE_MS]);
    next.settle(committed());
    expect(await second.outcome).toEqual({ kind: 'drained', settled: 1 });
  });

  it('resume after a failed drain reopens admission — the conflict path resumes the old editor', async () => {
    const fence = createEditFence({ clock: manualClock().clock });
    const edit = controlledEdit('entry');
    const drain = begunFence(fence, () => [edit.edit]);
    edit.settle(writeRejection('changed-baseline'));
    expect((await drain.outcome).kind).toBe('failed');

    expect(drain.resume()).toEqual({ kind: 'resumed' });
    expect(fence.state).toBe('open');
    expect(fence.submit(controlledEdit('after-conflict').edit).kind).toBe('accepted');
  });
});
