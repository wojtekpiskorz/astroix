import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveEntry } from '../../../core/route-resolver';
import { useContentStore } from './store';

const post: ActiveEntry = { collection: 'blog', entryId: '2024/post' };
const home: ActiveEntry = { collection: 'homepage', entryId: 'index' };

function reset(): void {
  useContentStore.setState({ activeEntry: null, pendingVerify: null, appliedLoadSeq: 0 });
}

describe('content store — active entry semantics (#71)', () => {
  beforeEach(reset);

  it('a manual list click opens the entry', () => {
    useContentStore.getState().selectEntry(post);
    expect(useContentStore.getState().activeEntry).toEqual(post);
  });

  it('a plain canvas resolution is adopted — hit selects, silence clears', () => {
    const { applyCanvasResolution } = useContentStore.getState();
    applyCanvasResolution(home, 1);
    expect(useContentStore.getState().activeEntry).toEqual(home);
    applyCanvasResolution(null, 2);
    expect(useContentStore.getState().activeEntry).toBeNull();
  });

  it('a load resolves at most once — stale seqs (remount, StrictMode pass, refetch) change nothing', () => {
    const { applyCanvasResolution } = useContentStore.getState();
    applyCanvasResolution(home, 2);
    applyCanvasResolution(post, 2);
    applyCanvasResolution(post, 1);
    expect(useContentStore.getState().activeEntry).toEqual(home);
  });

  it('an armed reverse navigation is verified by the next resolution: a match keeps the pick', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify(post);
    useContentStore.getState().applyCanvasResolution(post, 1);
    const state = useContentStore.getState();
    expect(state.pendingVerify).toBeNull();
    expect(state.activeEntry).toEqual(post);
  });

  it('a verification miss keeps the manual pick — the form-only fallback', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify(post);
    // forward resolution stays silent (ambiguity the pre-checks missed)
    useContentStore.getState().applyCanvasResolution(null, 1);
    // StrictMode's second effect pass replays the same load seq as a plain
    // adoption — the replay must not clear the pick the arm protected
    useContentStore.getState().applyCanvasResolution(null, 1);
    const state = useContentStore.getState();
    expect(state.pendingVerify).toBeNull();
    expect(state.activeEntry).toEqual(post);
  });

  it('the arm is consumed per load — a later load adopts plainly', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify(post);
    useContentStore.getState().applyCanvasResolution(null, 1);
    useContentStore.getState().applyCanvasResolution(home, 2);
    expect(useContentStore.getState().activeEntry).toEqual(home);
  });
});
