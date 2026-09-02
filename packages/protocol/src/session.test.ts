import { describe, expect, it } from 'vitest';
import { sessionRefSchema } from './session';

/**
 * SessionRef (#220 AC: SessionRef serialization; ADR-0006 §3): the public
 * session identity pair `{ runtimeEpoch, generation }` — correlation and
 * freshness data, not authentication.
 */
describe('sessionRefSchema', () => {
  const valid = { runtimeEpoch: 'epoch-4f2a', generation: 1 };

  it('parses the exact pair', () => {
    expect(sessionRefSchema.safeParse(valid)).toEqual({
      success: true,
      data: valid,
    });
  });

  it('survives a JSON wire round-trip unchanged', () => {
    const parsed = sessionRefSchema.parse(JSON.parse(JSON.stringify(valid)));
    expect(parsed).toEqual(valid);
  });

  it('rejects an empty epoch, missing fields, and unknown fields', () => {
    expect(sessionRefSchema.safeParse({ runtimeEpoch: '', generation: 1 }).success).toBe(false);
    expect(sessionRefSchema.safeParse({ runtimeEpoch: 'e' }).success).toBe(false);
    expect(sessionRefSchema.safeParse({ generation: 1 }).success).toBe(false);
    expect(sessionRefSchema.safeParse({ ...valid, capability: 'nope' }).success).toBe(false); // the ref is not authentication — nothing else rides along
  });

  it('rejects non-positive, fractional, or non-number generations', () => {
    expect(sessionRefSchema.safeParse({ ...valid, generation: 0 }).success).toBe(false);
    expect(sessionRefSchema.safeParse({ ...valid, generation: -1 }).success).toBe(false);
    expect(sessionRefSchema.safeParse({ ...valid, generation: 1.5 }).success).toBe(false);
    expect(sessionRefSchema.safeParse({ ...valid, generation: '2' }).success).toBe(false);
  });
});
