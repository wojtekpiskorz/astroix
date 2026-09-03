import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { createSessionGate, sameSessionPair } from './session-gate.ts';

/**
 * The session gate's focused lane (#241): pair-currency semantics — the
 * equality, the stale rejection, and the reset's closing move.
 */

const FIRST: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 1 };
const NEXT: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 2 };
const OTHER_EPOCH: SessionRef = { runtimeEpoch: 'other-epoch', generation: 1 };

describe('sameSessionPair', () => {
  it('is field-wise value equality, never identity', () => {
    expect(sameSessionPair({ ...FIRST }, FIRST)).toBe(true);
  });

  it('rejects generation drift, epoch drift, and null candidates', () => {
    expect(sameSessionPair(NEXT, FIRST)).toBe(false);
    expect(sameSessionPair(OTHER_EPOCH, FIRST)).toBe(false);
    expect(sameSessionPair(null, FIRST)).toBe(false);
    expect(sameSessionPair(undefined, FIRST)).toBe(false);
    expect(sameSessionPair(FIRST, null)).toBe(false);
  });
});

describe('createSessionGate', () => {
  it('accepts its own mint pair while open', () => {
    const gate = createSessionGate(FIRST);
    expect(gate.ref).toEqual(FIRST);
    expect(gate.isCurrent()).toBe(true);
    expect(gate.isCurrent({ ...FIRST })).toBe(true);
  });

  it('rejects every other pair', () => {
    const gate = createSessionGate(FIRST);
    expect(gate.isCurrent(NEXT)).toBe(false);
    expect(gate.isCurrent(OTHER_EPOCH)).toBe(false);
    expect(gate.isCurrent(null)).toBe(false);
    // `undefined` is the no-candidate open question (`isCurrent()`), not a pair —
    // the absent-session drop is whileCurrent's law, pinned below.
    expect(gate.isCurrent()).toBe(true);
  });

  it('runs whileCurrent only for the current pair', () => {
    const gate = createSessionGate(FIRST);
    let ran = 0;
    expect(gate.whileCurrent({ ...FIRST }, () => (ran += 1))).toBe(1);
    expect(gate.whileCurrent(NEXT, () => (ran += 1))).toBeUndefined();
    expect(gate.whileCurrent(undefined, () => (ran += 1))).toBeUndefined();
    expect(ran).toBe(1);
  });

  it('closes under move(null) — no candidate passes, isCurrent() goes false', () => {
    const gate = createSessionGate(FIRST);
    gate.move(null);
    expect(gate.isCurrent()).toBe(false);
    expect(gate.isCurrent(FIRST)).toBe(false);
    expect(gate.whileCurrent(FIRST, () => 1)).toBeUndefined();
  });

  it('keeps its mint identity after moving', () => {
    const gate = createSessionGate(FIRST);
    gate.move(null);
    expect(gate.ref).toEqual(FIRST);
  });
});
