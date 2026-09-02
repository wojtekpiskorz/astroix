import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  captureMenuAction,
  executeMenuAction,
} from '../../session-supervisor/clients/menu-actions.ts';

/**
 * The #236 focused tests, part 3 — the menu-action currency envelope
 * (ADR-0006 §5 "Menu actions capture the SessionRef visible at creation
 * and reject if stale at execution"): the native menu freezes the pair
 * at item creation; execution re-checks it against the currently active
 * session and refuses stale or session-less executions.
 */

const REF_1: SessionRef = { runtimeEpoch: 'epoch-236', generation: 1 };
const REF_2: SessionRef = { runtimeEpoch: 'epoch-236', generation: 2 };
const REF_NEXT_EPOCH: SessionRef = { runtimeEpoch: 'epoch-restart', generation: 1 };

describe('capture at creation', () => {
  it('freezes the visible SessionRef and carries the action id untouched', () => {
    const envelope = captureMenuAction({ sessionRef: REF_1, action: 'workbench.reset-selection' });
    expect(envelope).toEqual({ sessionRef: REF_1, action: 'workbench.reset-selection' });
  });
});

describe('execute at click time', () => {
  it('accepts when the captured pair is the exact current pair', () => {
    const envelope = captureMenuAction({ sessionRef: REF_1, action: 'workbench.reset-selection' });
    expect(executeMenuAction(envelope, REF_1)).toEqual({ kind: 'accepted', sessionRef: REF_1 });
  });

  it('rejects a stale generation (the A-to-B-to-A case: same epoch, new session)', () => {
    const envelope = captureMenuAction({ sessionRef: REF_1, action: 'content.save-entry' });
    expect(executeMenuAction(envelope, REF_2)).toEqual({
      kind: 'rejected',
      reason: 'stale-session',
    });
  });

  it('rejects a stale epoch (a control-plane restart retired the old epoch)', () => {
    const envelope = captureMenuAction({ sessionRef: REF_1, action: 'content.save-entry' });
    expect(executeMenuAction(envelope, REF_NEXT_EPOCH)).toEqual({
      kind: 'rejected',
      reason: 'stale-session',
    });
  });

  it('rejects when no active session exists (the launcher state)', () => {
    const envelope = captureMenuAction({ sessionRef: REF_1, action: 'workbench.reset-selection' });
    expect(executeMenuAction(envelope, null)).toEqual({
      kind: 'rejected',
      reason: 'no-active-session',
    });
  });

  it('the rejection never executes the action — the envelope is the only input it reads', () => {
    const stale = captureMenuAction({ sessionRef: REF_1, action: 'styles.splice-rule' });
    const result = executeMenuAction(stale, REF_2);
    // the rejected result carries no authority, no echo of the action payload
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({ kind: 'rejected', reason: 'stale-session' }),
    );
  });
});
