import { describe, expect, it } from 'vitest';
import { sessionQueryCount } from '../query/session-query-cache.ts';
import { createShellQueryClient } from '../query/shell-query-client.ts';
import { useAppStore } from '../state/app-store.ts';
import { useEditSessionStore } from '../state/edit-session-store.ts';
import { createSessionGate } from '../state/session-gate.ts';
import { bindShellSession, clearShellStores, shellStoreSnapshot } from '../state/shell-stores.ts';
import { composeShellReset, runShellReset, SHELL_RESET_STEPS } from './shell-reset.ts';

/**
 * The ordered reset's focused lane (#241's core AC): the sequencer's
 * step order is pinned EXACTLY by observers — abort old fetches, close
 * SSE, remove old-generation queries, clear the stores, and only then
 * navigate — and the composition wires each step to its real surface,
 * verified effect by effect.
 */

const FIRST = { runtimeEpoch: 'epoch-fixture', generation: 1 };

/** One selection descriptor — the #242 real shape of the store's selection slot. */
function aSelection() {
  return {
    tag: 'h1',
    id: null,
    classes: ['hero-title'],
    scopeAttributes: ['data-astro-cid-fixture'],
  };
}

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
