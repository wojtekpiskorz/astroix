import { describe, expect, it } from 'vitest';
import {
  QUERY_KEY_ROOT,
  sessionQueryKey,
  sessionScope,
  sessionScopeFromQueryKey,
} from './query-keys';

/**
 * Generation-scoped query keys (#220 AC; ADR-0006 §5): TanStack Query keys
 * start with `['astroix', runtimeEpoch, generation, ...]` — the whole
 * cache dies with the session at commit, so a key must never cross
 * sessions and a stale scope must be recognizable for purging.
 */
const ref = { runtimeEpoch: 'epoch-9c1d', generation: 3 };

describe('session-scoped query keys', () => {
  it('roots every session key with the ADR-0006 §5 triple', () => {
    expect(sessionScope(ref)).toEqual(['astroix', 'epoch-9c1d', 3]);
    expect(QUERY_KEY_ROOT).toBe('astroix');
    expect(sessionQueryKey(ref, 'content', 'entries')).toEqual([
      'astroix',
      'epoch-9c1d',
      3,
      'content',
      'entries',
    ]);
  });

  it('does not mutate the session pair while spreading scope', () => {
    const key = sessionQueryKey(ref, 'styles');
    expect(key).toHaveLength(4);
    expect(ref).toEqual({ runtimeEpoch: 'epoch-9c1d', generation: 3 });
  });

  it('reads the scope back out of a well-formed key', () => {
    expect(sessionScopeFromQueryKey(sessionQueryKey(ref, 'routes'))).toEqual(ref);
    expect(sessionScopeFromQueryKey(sessionScope(ref))).toEqual(ref);
  });

  it('returns null for keys that are not session-scoped', () => {
    expect(sessionScopeFromQueryKey(['settings', 'theme'])).toBe(null);
    expect(sessionScopeFromQueryKey([])).toBe(null);
    expect(sessionScopeFromQueryKey(['astroix'])).toBe(null);
    expect(
      sessionScopeFromQueryKey(['astroix', 'epoch-9c1d', '3']), // generation as string
    ).toBe(null);
    expect(sessionScopeFromQueryKey(['astroix', 'epoch-9c1d', 0])).toBe(null);
    expect(sessionScopeFromQueryKey(['astroix', 'epoch-9c1d', 3, 'extra'])).toEqual(ref);
  });

  it('distinguishes generations — a stale key never parses as the current session', () => {
    const stale = sessionQueryKey({ runtimeEpoch: 'epoch-9c1d', generation: 2 }, 'content');
    const parsed = sessionScopeFromQueryKey(stale);
    expect(parsed).not.toEqual(ref);
    expect(parsed).toEqual({ runtimeEpoch: 'epoch-9c1d', generation: 2 });
    const nextEpoch = sessionQueryKey({ runtimeEpoch: 'epoch-AAAA', generation: 3 }, 'content');
    expect(sessionScopeFromQueryKey(nextEpoch)).not.toEqual(ref);
  });
});
