import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_WRITE_DEBOUNCE_MS, createDebounceScheduler } from './debounce-scheduler.ts';
import { createEditQueue } from './edit-queue.ts';
import { IDLE_WRITE, reduceWrite } from './write-loop-state.ts';

/**
 * The shared edit drain/fence seam's own units (ADR-0002 amendment 5,
 * born #250/I2): the debounce scheduler's persist-on-pause law, the
 * edit queue's one-in-flight ordering, and the write-loop machine's
 * stale-settle law — the mechanical truths both verticals' write loops
 * stand on. (The machine's full matrix is exercised through the
 * Content and CSS write-loop tests; these pin the seam's own pieces.)
 */

describe('the debounce scheduler — the persist-on-pause law', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires after the settled pause', () => {
    const scheduler = createDebounceScheduler(300);
    const fired: string[] = [];
    scheduler.schedule('a', () => fired.push('a'));
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(299);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(['a']);
    expect(scheduler.pendingKeys()).toEqual([]);
  });

  it('a later schedule for the same key replaces the earlier one — the pause extends', () => {
    const scheduler = createDebounceScheduler(300);
    const fired: string[] = [];
    scheduler.schedule('a', () => fired.push('first'));
    vi.advanceTimersByTime(200);
    scheduler.schedule('a', () => fired.push('second'));
    vi.advanceTimersByTime(200);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(fired).toEqual(['second']);
  });

  it('independent keys schedule independently; cancel stops one; clear stops all', () => {
    const scheduler = createDebounceScheduler(300);
    const fired: string[] = [];
    scheduler.schedule('a', () => fired.push('a'));
    scheduler.schedule('b', () => fired.push('b'));
    expect([...scheduler.pendingKeys()].sort()).toEqual(['a', 'b']);
    scheduler.cancel('a');
    expect(scheduler.pendingKeys()).toEqual(['b']);
    scheduler.clear();
    expect(scheduler.pendingKeys()).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual([]);
  });

  it('the settled pause is the glossary\u2019s own ~300 ms', () => {
    expect(AUTO_WRITE_DEBOUNCE_MS).toBe(300);
  });
});

describe('the edit queue — the one-in-flight ordering', () => {
  it('serializes dispatches behind the live one', async () => {
    const queue = createEditQueue();
    const order: string[] = [];
    const gate = { release: Promise.resolve() };
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.enqueue(async () => {
      order.push('first-begin');
      await firstHeld;
      order.push('first-end');
    });
    const second = queue.enqueue(async () => {
      order.push('second-begin');
    });
    expect(queue.depth()).toBe(2);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-begin', 'first-end', 'second-begin']);
    expect(queue.depth()).toBe(0);
    void gate;
  });

  it('a rejected task settles its caller without poisoning the chain', async () => {
    const queue = createEditQueue();
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      throw new Error('the write refused');
    });
    await expect(first).rejects.toThrow('the write refused');
    await queue.enqueue(async () => {
      order.push('second');
    });
    expect(order).toEqual(['second']);
  });
});

describe('the write-loop machine — the stale-settle law', () => {
  it('a stale sequence never applies; reset is unconditional', () => {
    let state = IDLE_WRITE;
    state = reduceWrite(state, { type: 'submitted', seq: 1 });
    expect(state.phase).toBe('pending');
    // a stale settle (seq 0) never applies
    state = reduceWrite(state, { type: 'committed', seq: 0, revision: 9 });
    expect(state.phase).toBe('pending');
    // the live settle applies
    state = reduceWrite(state, { type: 'committed', seq: 1, revision: 2 });
    expect(state.phase).toBe('committed');
    expect(state.revision).toBe(2);
    // the reset is unconditional — even mid-refresh
    state = reduceWrite(state, { type: 'refresh-begun', seq: 1 });
    expect(state.phase).toBe('refresh-required');
    state = reduceWrite(state, { type: 'reset' });
    expect(state).toEqual(IDLE_WRITE);
  });

  it('a submitted is legal only from idle and only forward', () => {
    let state = IDLE_WRITE;
    state = reduceWrite(state, { type: 'submitted', seq: 1 });
    // a second submitted while pending never applies
    state = reduceWrite(state, { type: 'submitted', seq: 2 });
    expect(state.phase).toBe('pending');
    expect(state.seq).toBe(1);
    state = reduceWrite(state, { type: 'rejected', seq: 1, code: 'x' });
    // from rejected, a forward submitted still refuses — reset first
    state = reduceWrite(state, { type: 'submitted', seq: 3 });
    expect(state.phase).toBe('rejected');
  });
});
