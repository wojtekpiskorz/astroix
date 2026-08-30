import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveEntry } from '../../../core/route-resolver';
import type { CanvasLoad } from '../../store';
import { useContentStore } from './store';

const post: ActiveEntry = { collection: 'blog', entryId: '2024/post' };
const home: ActiveEntry = { collection: 'homepage', entryId: 'index' };

const POST_LOAD: CanvasLoad = { url: 'http://localhost:4314/blog/2024/post?builder=0', seq: 1 };
const HOME_LOAD: CanvasLoad = { url: 'http://localhost:4314/?builder=0', seq: 2 };

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
    applyCanvasResolution(home, { ...HOME_LOAD, seq: 1 });
    expect(useContentStore.getState().activeEntry).toEqual(home);
    applyCanvasResolution(null, { ...HOME_LOAD, seq: 2 });
    expect(useContentStore.getState().activeEntry).toBeNull();
  });

  it('a load resolves at most once — stale seqs (remount, StrictMode pass, refetch) change nothing', () => {
    const { applyCanvasResolution } = useContentStore.getState();
    applyCanvasResolution(home, { ...HOME_LOAD, seq: 2 });
    applyCanvasResolution(post, { ...POST_LOAD, seq: 2 });
    applyCanvasResolution(post, { ...POST_LOAD, seq: 1 });
    expect(useContentStore.getState().activeEntry).toEqual(home);
  });

  it('an armed reverse navigation is verified by the next resolution: a match keeps the pick', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify('/blog/2024/post');
    useContentStore.getState().applyCanvasResolution(post, POST_LOAD);
    const state = useContentStore.getState();
    expect(state.pendingVerify).toBeNull();
    expect(state.activeEntry).toEqual(post);
  });

  it('a verification miss keeps the manual pick — the form-only fallback', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify('/blog/2024/post');
    // forward resolution stays silent (ambiguity the pre-checks missed)
    useContentStore.getState().applyCanvasResolution(null, POST_LOAD);
    // StrictMode's second effect pass replays the same load seq as a plain
    // adoption — the replay must not clear the pick the arm protected
    useContentStore.getState().applyCanvasResolution(null, POST_LOAD);
    const state = useContentStore.getState();
    expect(state.pendingVerify).toBeNull();
    expect(state.activeEntry).toEqual(post);
  });

  it('the arm is consumed per load — a later load adopts plainly', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify('/blog/2024/post');
    useContentStore.getState().applyCanvasResolution(null, POST_LOAD);
    useContentStore.getState().applyCanvasResolution(home, HOME_LOAD);
    expect(useContentStore.getState().activeEntry).toEqual(home);
  });
});

describe('content store — a stale arm never eats a plain navigation (#140)', () => {
  beforeEach(reset);

  // the discriminated flake shape: the armed navigation's load event never
  // fires (a newer navigation superseded it before window-load), so the arm
  // survives into the next load — whose URL proves it is a different,
  // plain navigation: its resolution is adopted, silence clears the pick
  it('a load for a URL other than the armed target adopts the resolution — silence clears', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify('/blog/2024/post');
    useContentStore.getState().applyCanvasResolution(null, HOME_LOAD);
    const state = useContentStore.getState();
    expect(state.pendingVerify).toBeNull();
    expect(state.activeEntry).toBeNull();
  });

  it('a superseding load that resolves an entry adopts it as the active entry', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify('/blog/2024/post');
    useContentStore.getState().applyCanvasResolution(home, HOME_LOAD);
    expect(useContentStore.getState().activeEntry).toEqual(home);
  });

  it('the target matches on pathname — query and fragment are not part of the identity', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify('/blog/2024/post');
    // the synthetic miss shape: a resolution over the armed target's own
    // pathname must take the verify branch (miss keeps the pick) — a
    // comparator that regressed to full-URL equality would read this load
    // as foreign and adopt the silence, clearing the pick
    useContentStore
      .getState()
      .applyCanvasResolution(null, { ...POST_LOAD, url: `${POST_LOAD.url}&x=1#frag` });
    const state = useContentStore.getState();
    expect(state.pendingVerify).toBeNull();
    expect(state.activeEntry).toEqual(post);
  });
});
