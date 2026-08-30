import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveEntry } from '../../../core/route-resolver';
import { useContentStore } from './store';

const post: ActiveEntry = { collection: 'blog', entryId: '2024/post' };
const home: ActiveEntry = { collection: 'homepage', entryId: 'index' };

const POST_URL = 'http://localhost:4314/blog/2024/post?builder=0';
const HOME_URL = 'http://localhost:4314/?builder=0';

function reset(): void {
  useContentStore.setState({
    activeEntry: null,
    pendingVerify: null,
    verifyTarget: null,
    appliedLoadSeq: 0,
  });
}

describe('content store — active entry semantics (#71)', () => {
  beforeEach(reset);

  it('a manual list click opens the entry', () => {
    useContentStore.getState().selectEntry(post);
    expect(useContentStore.getState().activeEntry).toEqual(post);
  });

  it('a plain canvas resolution is adopted — hit selects, silence clears', () => {
    const { applyCanvasResolution } = useContentStore.getState();
    applyCanvasResolution(home, 1, HOME_URL);
    expect(useContentStore.getState().activeEntry).toEqual(home);
    applyCanvasResolution(null, 2, HOME_URL);
    expect(useContentStore.getState().activeEntry).toBeNull();
  });

  it('a load resolves at most once — stale seqs (remount, StrictMode pass, refetch) change nothing', () => {
    const { applyCanvasResolution } = useContentStore.getState();
    applyCanvasResolution(home, 2, HOME_URL);
    applyCanvasResolution(post, 2, POST_URL);
    applyCanvasResolution(post, 1, POST_URL);
    expect(useContentStore.getState().activeEntry).toEqual(home);
  });

  it('an armed reverse navigation is verified by the next resolution: a match keeps the pick', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify(post, '/blog/2024/post');
    useContentStore.getState().applyCanvasResolution(post, 1, POST_URL);
    const state = useContentStore.getState();
    expect(state.pendingVerify).toBeNull();
    expect(state.activeEntry).toEqual(post);
  });

  it('a verification miss keeps the manual pick — the form-only fallback', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify(post, '/blog/2024/post');
    // forward resolution stays silent (ambiguity the pre-checks missed)
    useContentStore.getState().applyCanvasResolution(null, 1, POST_URL);
    // StrictMode's second effect pass replays the same load seq as a plain
    // adoption — the replay must not clear the pick the arm protected
    useContentStore.getState().applyCanvasResolution(null, 1, POST_URL);
    const state = useContentStore.getState();
    expect(state.pendingVerify).toBeNull();
    expect(state.activeEntry).toEqual(post);
  });

  it('the arm is consumed per load — a later load adopts plainly', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify(post, '/blog/2024/post');
    useContentStore.getState().applyCanvasResolution(null, 1, POST_URL);
    useContentStore.getState().applyCanvasResolution(home, 2, HOME_URL);
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
    store.armReverseVerify(post, '/blog/2024/post');
    useContentStore.getState().applyCanvasResolution(null, 1, HOME_URL);
    const state = useContentStore.getState();
    expect(state.pendingVerify).toBeNull();
    expect(state.verifyTarget).toBeNull();
    expect(state.activeEntry).toBeNull();
  });

  it('a superseding load that resolves an entry adopts it as the active entry', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify(post, '/blog/2024/post');
    useContentStore.getState().applyCanvasResolution(home, 1, HOME_URL);
    expect(useContentStore.getState().activeEntry).toEqual(home);
  });

  it('the target matches on pathname — query and fragment are not part of the identity', () => {
    const store = useContentStore.getState();
    store.selectEntry(post);
    store.armReverseVerify(post, '/blog/2024/post');
    useContentStore.getState().applyCanvasResolution(post, 1, `${POST_URL}&x=1`);
    expect(useContentStore.getState().activeEntry).toEqual(post);
  });
});
