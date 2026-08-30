import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChromeStore } from '../../store';
import { COLLECTIONS_KEY, SCHEMA_KEY } from './api';
import { invalidateOnContentSynced } from './synced-invalidation';

// #155's sequencing contract, pinned at the unit seam: the loader leg's
// invalidation waits for the canvas's next load (or the bounded fallback),
// the srcDir leg fires immediately. The store and the QueryClient are the
// real ones — the only doubles are the clock and the invalidation spy.

function armedClient(): { client: QueryClient; invalidations: ReturnType<typeof vi.fn> } {
  const client = new QueryClient();
  const invalidations = vi.fn();
  vi.spyOn(client, 'invalidateQueries').mockImplementation(invalidations);
  return { client, invalidations };
}

function expectBothCachesInvalidated(invalidations: ReturnType<typeof vi.fn>): void {
  expect(invalidations).toHaveBeenCalledWith({ queryKey: COLLECTIONS_KEY });
  expect(invalidations).toHaveBeenCalledWith({ queryKey: SCHEMA_KEY });
}

describe('invalidateOnContentSynced (#155)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChromeStore.setState({ canvasLoad: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the srcDir leg invalidates immediately — its refetch lands well before the reload', () => {
    const { client, invalidations } = armedClient();
    invalidateOnContentSynced(client, 'srcdir');
    expectBothCachesInvalidated(invalidations);
  });

  it('the loader leg holds until the next canvas load bumps the seq', () => {
    const { client, invalidations } = armedClient();
    invalidateOnContentSynced(client, 'loader');
    expect(invalidations).not.toHaveBeenCalled();

    useChromeStore.getState().reportCanvasLoad('http://localhost:4314/blog/hello-builder');
    expectBothCachesInvalidated(invalidations);
  });

  it('a load that fired before the arm never satisfies the wait — only a seq bump does', () => {
    useChromeStore.getState().reportCanvasLoad('http://localhost:4314/');
    const { client, invalidations } = armedClient();
    invalidateOnContentSynced(client, 'loader');

    // a store change that is not a newer load settles nothing
    useChromeStore.setState({ selectMode: true });
    expect(invalidations).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3_000);
    expectBothCachesInvalidated(invalidations);
  });

  it('a settled wait is done — later loads never re-invalidate', () => {
    const { client, invalidations } = armedClient();
    invalidateOnContentSynced(client, 'loader');
    useChromeStore.getState().reportCanvasLoad('http://localhost:4314/');
    expect(invalidations).toHaveBeenCalledTimes(2);

    useChromeStore.getState().reportCanvasLoad('http://localhost:4314/blog/2024/post');
    vi.advanceTimersByTime(3_000);
    expect(invalidations).toHaveBeenCalledTimes(2);
  });

  it('the bounded fallback refreshes the sidebar when no canvas load ever comes', () => {
    const { client, invalidations } = armedClient();
    invalidateOnContentSynced(client, 'loader');
    vi.advanceTimersByTime(2_999);
    expect(invalidations).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expectBothCachesInvalidated(invalidations);
  });
});
