import { describe, expect, it } from 'vitest';
import {
  SESSION_LABELS,
  sessionFailureSchema,
  sessionLabel,
  sessionSnapshotSchema,
} from './session-state';

/**
 * The session snapshot (ADR-0006 §4): the source of truth is the snapshot,
 * not a flat enum; the labels are derived — and the derivation must honor
 * "a staged-candidate failure while an old project is ready is a
 * notification, not the global state".
 */
const projectKey = 'abcdefghijklmnopqrstuvwxyz';
const ref = { runtimeEpoch: 'epoch-1', generation: 2 };

describe('sessionSnapshotSchema', () => {
  it('parses the empty snapshot (idle), each single state, and the A-to-B overlap', () => {
    expect(sessionSnapshotSchema.safeParse({}).success).toBe(true);
    expect(
      sessionSnapshotSchema.safeParse({ active: { ref, projectKey, state: 'ready' } }).success,
    ).toBe(true);
    expect(
      sessionSnapshotSchema.safeParse({ attempt: { ref, projectKey, state: 'committing' } })
        .success,
    ).toBe(true);
    // The existing ready project stays authoritative while the candidate starts (§4 step 1).
    expect(
      sessionSnapshotSchema.safeParse({
        active: { ref, projectKey, state: 'ready' },
        attempt: {
          ref: { runtimeEpoch: 'epoch-1', generation: 3 },
          projectKey,
          state: 'starting',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects off-enum states, unknown fields, and malformed refs', () => {
    expect(
      sessionSnapshotSchema.safeParse({ active: { ref, projectKey, state: 'idle' } }).success,
    ).toBe(false);
    expect(
      sessionSnapshotSchema.safeParse({ active: { ref, projectKey, state: 'ready', pid: 1 } })
        .success,
    ).toBe(false);
    expect(
      sessionSnapshotSchema.safeParse({
        active: { ref: { ...ref, generation: 0 }, projectKey, state: 'ready' },
      }).success,
    ).toBe(false);
  });

  it('keeps failures sanitized: category + guarded message only', () => {
    expect(
      sessionFailureSchema.safeParse({
        category: 'drain-timeout',
        message: 'editor did not settle',
      }).success,
    ).toBe(true);
    expect(sessionFailureSchema.safeParse({ category: 'surprise', message: 'x' }).success).toBe(
      false,
    );
    expect(
      sessionFailureSchema.safeParse({ category: 'crash', message: 'at /Users/owner/x (a.js:1:1)' })
        .success,
    ).toBe(false);
  });
});

describe('sessionLabel — the canonical derivation', () => {
  const cases: ReadonlyArray<[string, Record<string, unknown>, (typeof SESSION_LABELS)[number]]> = [
    ['idle when empty', {}, 'idle'],
    ['ready when active and ready', { active: { ref, projectKey, state: 'ready' } }, 'ready'],
    [
      'stopping when active is stopping',
      { active: { ref, projectKey, state: 'stopping' } },
      'stopping',
    ],
    [
      'starting when only an attempt exists (starting)',
      { attempt: { ref, projectKey, state: 'starting' } },
      'starting',
    ],
    [
      'starting when only an attempt exists (committing)',
      { attempt: { ref, projectKey, state: 'committing' } },
      'starting',
    ],
    [
      'failed when the latest attempt failed and no authority remains',
      { lastFailure: { category: 'revocation', message: 'commit failed after revocation' } },
      'failed',
    ],
    [
      'ready, not failed: a candidate failure while the old project is ready is a notification',
      {
        active: { ref, projectKey, state: 'ready' },
        lastFailure: { category: 'startup-timeout', message: 'candidate missed its deadline' },
      },
      'ready',
    ],
    [
      'ready, not starting: an active session outranks a staged candidate',
      {
        active: { ref, projectKey, state: 'ready' },
        attempt: { ref: { runtimeEpoch: 'epoch-1', generation: 3 }, projectKey, state: 'starting' },
      },
      'ready',
    ],
  ];

  it('derives every label from the snapshot precedence', () => {
    for (const [name, snapshot, expected] of cases) {
      expect(sessionLabel(sessionSnapshotSchema.parse(snapshot)), name).toBe(expected);
    }
    expect(SESSION_LABELS).toEqual(['idle', 'starting', 'ready', 'stopping', 'failed']);
  });
});
