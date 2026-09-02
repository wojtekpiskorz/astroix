import { describe, expect, it } from 'vitest';
import { EVENT_SESSION_PRESENCE, sseEventEnvelopeSchema, sseEventSchema } from './events';
import { envelopeBytes, LIMITS } from './limits';

/**
 * SSE event frames (ADR-0006 §7: session-scoped events carry SessionRef;
 * ADR-0005: revisioned invalidations and structured diagnostics; the 256
 * KiB per-event cap).
 */
const session = { runtimeEpoch: 'epoch-3b', generation: 9 };

describe('sseEventSchema', () => {
  it('parses each frame type with its closed payload', () => {
    expect(sseEventSchema.safeParse({ type: 'session-state', snapshot: {} }).success).toBe(true);
    expect(
      sseEventSchema.safeParse({ type: 'invalidation', families: ['styles'], revision: 4 }).success,
    ).toBe(true);
    expect(
      sseEventSchema.safeParse({ type: 'diagnostic', level: 'warn', message: 'watcher resynced' })
        .success,
    ).toBe(true);
    expect(sseEventSchema.safeParse({ type: 'registry-changed' }).success).toBe(true);
  });

  it('rejects malformed discriminants, unknown families, and unsanitized diagnostics', () => {
    expect(sseEventSchema.safeParse({ type: 'hmr' }).success).toBe(false);
    expect(sseEventSchema.safeParse({}).success).toBe(false);
    expect(
      sseEventSchema.safeParse({ type: 'invalidation', families: [], revision: 1 }).success,
    ).toBe(false);
    expect(
      sseEventSchema.safeParse({ type: 'invalidation', families: ['modules'], revision: 1 })
        .success,
    ).toBe(false);
    expect(
      sseEventSchema.safeParse({
        type: 'diagnostic',
        level: 'verbose',
        message: 'recompiling',
      }).success,
    ).toBe(false);
    expect(
      sseEventSchema.safeParse({
        type: 'diagnostic',
        level: 'error',
        message: 'vite at /Users/owner/site',
      }).success,
    ).toBe(false);
  });
});

describe('sseEventEnvelopeSchema', () => {
  it('carries the exact SessionRef on session-scoped frames', () => {
    const frame = {
      protocolVersion: 1,
      session,
      event: { type: 'invalidation', families: ['content', 'routes'], revision: 11 },
    };
    expect(sseEventEnvelopeSchema.safeParse(frame)).toEqual({ success: true, data: frame });
    expect(
      sseEventEnvelopeSchema.safeParse({
        protocolVersion: 1,
        session,
        event: {
          type: 'session-state',
          snapshot: { active: { ref: session, projectKey: 'a'.repeat(26), state: 'ready' } },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a session-scoped frame without its SessionRef', () => {
    expect(
      sseEventEnvelopeSchema.safeParse({
        protocolVersion: 1,
        event: { type: 'invalidation', families: ['styles'], revision: 2 },
      }).success,
    ).toBe(false);
    expect(
      sseEventEnvelopeSchema.safeParse({
        protocolVersion: 1,
        event: { type: 'diagnostic', level: 'info', message: 'reindexed' },
      }).success,
    ).toBe(false);
  });

  it('keeps the registry nudge session-free and version-checked', () => {
    const frame = { protocolVersion: 1, event: { type: 'registry-changed' } };
    expect(sseEventEnvelopeSchema.safeParse(frame)).toEqual({ success: true, data: frame });
    expect(sseEventEnvelopeSchema.safeParse({ ...frame, session }).success).toBe(false);
    expect(
      sseEventEnvelopeSchema.safeParse({
        protocolVersion: 2,
        event: { type: 'registry-changed' },
      }).success,
    ).toBe(false);
    expect(
      sseEventEnvelopeSchema.safeParse({
        protocolVersion: 1,
        session,
        event: { type: 'registry-changed' },
        retry: '5s', // unknown envelope fields never ride an event frame
      }).success,
    ).toBe(false);
  });

  it('binds each event type to its presence rule', () => {
    expect(EVENT_SESSION_PRESENCE).toEqual({
      'session-state': 'required',
      invalidation: 'required',
      diagnostic: 'required',
      'registry-changed': 'forbidden',
    });
  });

  it('measures frames against the 256 KiB per-event cap (ADR-0006 §7)', () => {
    const frame = {
      protocolVersion: 1,
      session,
      event: { type: 'diagnostic', level: 'info', message: 'm'.repeat(1000) },
    };
    expect(envelopeBytes(frame)).toBeLessThan(LIMITS.sseEventBytes);
    const oversized = {
      ...frame,
      event: { type: 'diagnostic', level: 'info', message: 'm'.repeat(LIMITS.sseEventBytes) },
    };
    expect(envelopeBytes(oversized)).toBeGreaterThan(LIMITS.sseEventBytes);
  });
});
