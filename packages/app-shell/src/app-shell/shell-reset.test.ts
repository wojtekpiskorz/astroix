import { describe, expect, it } from 'vitest';
import { useDiscoveryStore } from '../features/content/discovery/discovery-store.ts';
import { useFormDraftStore } from '../features/content/forms/form-draft-store.ts';
import { useContentNavigationStore } from '../features/content/navigation/navigation-store.ts';
import { IDLE_WRITE } from '../features/content/write/write-state.ts';
import { useContentWriteStore } from '../features/content/write/write-store.ts';
import { useCssInspectionStore } from '../features/css/store.ts';
import { sessionQueryCount } from '../query/session-query-cache.ts';
import { createShellQueryClient } from '../query/shell-query-client.ts';
import { useAppStore } from '../state/app-store.ts';
import { useEditSessionStore } from '../state/edit-session-store.ts';
import {
  registeredFeatureStoreKeys,
  registerFeatureStoreReset,
} from '../state/feature-store-registry.ts';
import { createSessionGate } from '../state/session-gate.ts';
import { bindShellSession, clearShellStores, shellStoreSnapshot } from '../state/shell-stores.ts';
import { aSelection } from '../state/test-fixtures.ts';
import { composeShellReset, runShellReset, SHELL_RESET_STEPS } from './shell-reset.ts';

/**
 * The ordered reset's focused lane (#241's core AC): the sequencer's
 * step order is pinned EXACTLY by observers — abort old fetches, close
 * SSE, remove old-generation queries, clear the stores, and only then
 * navigate — and the composition wires each step to its real surface,
 * verified effect by effect.
 */

const FIRST = { runtimeEpoch: 'epoch-fixture', generation: 1 };
const NEXT = { runtimeEpoch: 'epoch-fixture', generation: 2 };

describe('runShellReset', () => {
  it('pins the step order — abort, close, remove, clear, then navigate', () => {
    expect([...SHELL_RESET_STEPS]).toEqual([
      'abort-fetches',
      'close-sse',
      'remove-queries',
      'clear-stores',
      'navigate',
    ]);
  });

  it('observes each step before and after its action, in the pinned order', () => {
    const calls: string[] = [];
    runShellReset(
      {
        abortFetches: () => calls.push('do:abort-fetches'),
        closeEvents: () => calls.push('do:close-sse'),
        removeQueries: () => calls.push('do:remove-queries'),
        clearStores: () => calls.push('do:clear-stores'),
        navigate: () => calls.push('do:navigate'),
      },
      {
        onStep: (step) => calls.push(`before:${step}`),
        onStepDone: (step) => calls.push(`after:${step}`),
      },
    );
    expect(calls).toEqual([
      'before:abort-fetches',
      'do:abort-fetches',
      'after:abort-fetches',
      'before:close-sse',
      'do:close-sse',
      'after:close-sse',
      'before:remove-queries',
      'do:remove-queries',
      'after:remove-queries',
      'before:clear-stores',
      'do:clear-stores',
      'after:clear-stores',
      'before:navigate',
      'do:navigate',
      'after:navigate',
    ]);
  });
});

describe('composeShellReset', () => {
  it('wires the real surfaces — each step really does its work, navigation last', () => {
    // Pre-reset state: one cached session query, every store field populated.
    const controller = new AbortController();
    let eventsClosed = 0;
    const queryClient = createShellQueryClient();
    queryClient.setQueryData(['astroix', FIRST.runtimeEpoch, FIRST.generation, 'project'], {
      revision: 1,
    });
    const gate = createSessionGate(FIRST);
    clearShellStores();
    bindShellSession(FIRST);
    const app = useAppStore.getState();
    app.setSelection(FIRST, aSelection());
    app.setCanvasState(FIRST, { url: 'http://project.localhost/', origin: 'project' });
    app.setActiveEntry(FIRST, { entryId: 'entry-1' });
    const edit = useEditSessionStore.getState();
    edit.holdGrant(FIRST, { token: 'grant' });
    edit.pushUndo(FIRST, { token: 'undo' });
    edit.scheduleDebounce(FIRST, { key: 'k', dueAtMs: 300 });
    edit.trackPendingMutation(FIRST, { key: 'm' });
    expect(shellStoreSnapshot().grants).toBe(1);

    const navigations: string[] = [];
    composeShellReset({
      fetchAbort: controller,
      events: { close: () => (eventsClosed += 1) },
      queryClient,
      gate,
      navigate: (url) => navigations.push(url),
      url: 'http://launcher.localhost:4426/__astroix/app/',
    }).run();

    expect(controller.signal.aborted).toBe(true); // 1. old fetches aborted
    expect(eventsClosed).toBe(1); // 2. old SSE closed
    expect(sessionQueryCount(queryClient)).toBe(0); // 3. old-generation queries removed
    expect(shellStoreSnapshot()).toEqual({
      // 4. the seven store fields cleared
      selection: false,
      canvas: false,
      activeEntry: false,
      grants: 0,
      undo: 0,
      debounces: 0,
      pendingMutations: 0,
    });
    expect(gate.isCurrent()).toBe(false); // the state belt closed with the stores
    expect(navigations).toEqual(['http://launcher.localhost:4426/__astroix/app/']); // 5. navigate LAST
  });

  it('records the clearing order through an observer — removal and clearing precede navigation', () => {
    const steps: string[] = [];
    composeShellReset({
      fetchAbort: new AbortController(),
      events: { close: () => {} },
      queryClient: createShellQueryClient(),
      gate: createSessionGate(FIRST),
      navigate: () => {},
      url: 'http://launcher.localhost:4426/__astroix/app/',
    }).run({ onStepDone: (step) => steps.push(step) });
    expect(steps.indexOf('remove-queries')).toBeLessThan(steps.indexOf('navigate'));
    expect(steps.indexOf('clear-stores')).toBeLessThan(steps.indexOf('navigate'));
    expect(steps.indexOf('abort-fetches')).toBe(0);
  });
});

describe('the feature-store wing (#372 — the registration registry)', () => {
  it('censuses the five landed feature-store registrations', () => {
    // Importing the feature stores registers them (module scope, beside
    // each creation) — the census is the structural proof the imports
    // alone wire the wing.
    expect(registeredFeatureStoreKeys()).toEqual(
      expect.arrayContaining([
        'content:discovery',
        'content:form-draft',
        'content:navigation',
        'content:write',
        'css:inspection',
      ]),
    );
  });

  it('clears a registered store INSIDE the clear-stores step — never earlier, never after navigation', () => {
    const calls: string[] = [];
    const handle = registerFeatureStoreReset('test:probe', () => calls.push('probe:reset'));
    try {
      composeShellReset({
        fetchAbort: new AbortController(),
        events: { close: () => {} },
        queryClient: createShellQueryClient(),
        gate: createSessionGate(FIRST),
        navigate: (url) => {
          calls.push(`do:navigate:${url}`);
        },
        url: 'http://launcher.localhost:4426/__astroix/app/',
      }).run({
        onStep: (step) => calls.push(`before:${step}`),
        onStepDone: (step) => calls.push(`after:${step}`),
      });
      // The full pinned order with the probe inside the clear-stores
      // step: after the shell stores clear, before the step completes —
      // and navigation stays LAST.
      expect(calls).toEqual([
        'before:abort-fetches',
        'after:abort-fetches',
        'before:close-sse',
        'after:close-sse',
        'before:remove-queries',
        'after:remove-queries',
        'before:clear-stores',
        'probe:reset',
        'after:clear-stores',
        'before:navigate',
        'do:navigate:http://launcher.localhost:4426/__astroix/app/',
        'after:navigate',
      ]);
    } finally {
      handle.unregister();
    }
  });

  it('an UNregistered store is not cleared at the commit — the lifecycle reaches the sequencer', () => {
    let cleared = 0;
    const handle = registerFeatureStoreReset('test:transient', () => (cleared += 1));
    handle.unregister();
    composeShellReset({
      fetchAbort: new AbortController(),
      events: { close: () => {} },
      queryClient: createShellQueryClient(),
      gate: createSessionGate(FIRST),
      navigate: () => {},
      url: 'http://launcher.localhost:4426/__astroix/app/',
    }).run();
    expect(cleared).toBe(0);
  });

  it('a same-document session switch leaves no stale feature state — every registered store clears at the commit', () => {
    // Session A's live state: shell slots plus every feature store the
    // verticals own — the exact stale-state scenario of the issue (a
    // future desktop-host activation path switching sessions WITHOUT
    // replacing the document).
    clearShellStores();
    bindShellSession(FIRST);
    const app = useAppStore.getState();
    app.setSelection(FIRST, aSelection());
    app.setActiveEntry(FIRST, { entryId: 'hello-builder' });
    useEditSessionStore.getState().holdGrant(FIRST, { token: 'grant-a' });
    useDiscoveryStore.getState().toggleFolder('blog/2024');
    useContentNavigationStore.getState().setActiveEntry({
      collection: 'blog',
      entryId: 'hello-builder',
    });
    useContentNavigationStore.getState().reportNoRoute('other-entry');
    useFormDraftStore
      .getState()
      .open(
        FIRST,
        { ...FIRST, collection: 'blog', entryId: 'hello-builder' },
        { revision: 'a'.repeat(64), values: { title: 'STALE DOCUMENT DRAFT' }, body: null },
        [],
      );
    const write = useContentWriteStore.getState();
    const seq = write.nextSeq();
    write.dispatch({ type: 'submitted', seq });
    useCssInspectionStore.getState().openRow('rule-1');
    useCssInspectionStore.getState().noteServed('/blog/', 3);

    // The commit: the one ordered reset — the same sequencer a
    // same-document switch executes.
    composeShellReset({
      fetchAbort: new AbortController(),
      events: { close: () => {} },
      queryClient: createShellQueryClient(),
      gate: createSessionGate(FIRST),
      navigate: () => {},
      url: 'http://launcher.localhost:4426/__astroix/app/',
    }).run();

    // Session B adopts the SAME document: nothing of A survives — not
    // in the shell stores, not in any feature store.
    bindShellSession(NEXT);
    expect(shellStoreSnapshot()).toEqual({
      selection: false,
      canvas: false,
      activeEntry: false,
      grants: 0,
      undo: 0,
      debounces: 0,
      pendingMutations: 0,
    });
    expect(useDiscoveryStore.getState().collapsedFolders.size).toBe(0);
    const navigation = useContentNavigationStore.getState();
    expect(navigation.activeEntry).toBeNull();
    expect(navigation.feedback).toEqual({ kind: 'none' });
    const draft = useFormDraftStore.getState();
    expect(draft.binding).toBeNull();
    expect(draft.draftValues).toBeUndefined();
    // The write machine is quiet, the mint SURVIVES (never reset, never
    // reused), and A's late settle for its dead sequence is refused.
    const writeAfter = useContentWriteStore.getState();
    expect(writeAfter.write).toEqual(IDLE_WRITE);
    expect(writeAfter.seqMint).toBe(seq);
    writeAfter.dispatch({ type: 'committed', seq, revision: 9 });
    expect(useContentWriteStore.getState().write).toEqual(IDLE_WRITE);
    const css = useCssInspectionStore.getState();
    expect(css.openRowKey).toBeNull();
    expect(css.served).toBeNull();
  });
});
