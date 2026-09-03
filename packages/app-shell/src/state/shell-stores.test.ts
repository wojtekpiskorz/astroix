import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './app-store.ts';
import { useEditSessionStore } from './edit-session-store.ts';
import { bindShellSession, clearShellStores, shellStoreSnapshot } from './shell-stores.ts';

/**
 * The shell stores' focused lane (#241): the reset-clearable fields,
 * their session binding, and the second belt — a write carrying a
 * moved-past pair (or any write after the reset unbound the store)
 * never lands. The seven fields of the AC's clearing list are populated
 * and asserted cleared.
 */

const FIRST: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 1 };
const NEXT: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 2 };

beforeEach(() => {
  clearShellStores();
});

describe('the app store', () => {
  it('binds at one exact pair and takes writes only under it', () => {
    useAppStore.getState().bindSession(FIRST);
    useAppStore.getState().setSelection(FIRST, { tag: 'h1', elementId: null });
    expect(useAppStore.getState().selection).toEqual({ tag: 'h1', elementId: null });
  });

  it('drops stale-pair writes — the second belt at the state layer', () => {
    useAppStore.getState().bindSession(FIRST);
    useAppStore.getState().setSelection(NEXT, { tag: 'h1', elementId: null });
    useAppStore.getState().setCanvasState(NEXT, { url: 'http://project.localhost/x' });
    useAppStore.getState().setActiveEntry(NEXT, { entryId: 'entry-1' });
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().canvas).toBeNull();
    expect(useAppStore.getState().activeEntry).toBeNull();
  });

  it('drops every write after clear unbound the store', () => {
    useAppStore.getState().bindSession(FIRST);
    useAppStore.getState().setActiveEntry(FIRST, { entryId: 'entry-1' });
    clearShellStores();
    useAppStore.getState().setActiveEntry(FIRST, { entryId: 'entry-2' });
    expect(useAppStore.getState().activeEntry).toBeNull();
    expect(useAppStore.getState().session).toBeNull();
  });
});

describe('the edit session store', () => {
  it('holds grants, undo, debounces, and pending mutations under the bound pair', () => {
    useEditSessionStore.getState().bindSession(FIRST);
    const edit = useEditSessionStore.getState();
    edit.holdGrant(FIRST, { token: 'grant-opaque-1' });
    edit.pushUndo(FIRST, { token: 'undo-opaque-1' });
    edit.scheduleDebounce(FIRST, { key: 'css-rule-1', dueAtMs: 300 });
    edit.trackPendingMutation(FIRST, { key: 'entry-2' });
    const snapshot = shellStoreSnapshot();
    expect(snapshot.grants).toBe(1);
    expect(snapshot.undo).toBe(1);
    expect(snapshot.debounces).toBe(1);
    expect(snapshot.pendingMutations).toBe(1);
  });

  it('replaces a same-key debounce scheduling', () => {
    useEditSessionStore.getState().bindSession(FIRST);
    const edit = useEditSessionStore.getState();
    edit.scheduleDebounce(FIRST, { key: 'css-rule-1', dueAtMs: 300 });
    edit.scheduleDebounce(FIRST, { key: 'css-rule-1', dueAtMs: 900 });
    expect(useEditSessionStore.getState().debounces).toEqual([{ key: 'css-rule-1', dueAtMs: 900 }]);
  });

  it('drops stale-pair writes on every setter', () => {
    useEditSessionStore.getState().bindSession(FIRST);
    const edit = useEditSessionStore.getState();
    edit.holdGrant(NEXT, { token: 'grant' });
    edit.pushUndo(NEXT, { token: 'undo' });
    edit.scheduleDebounce(NEXT, { key: 'k', dueAtMs: 1 });
    edit.trackPendingMutation(NEXT, { key: 'm' });
    expect(shellStoreSnapshot()).toEqual({
      selection: false,
      canvas: false,
      activeEntry: false,
      grants: 0,
      undo: 0,
      debounces: 0,
      pendingMutations: 0,
    });
  });
});

describe('the shell-stores aggregate', () => {
  it('populates every reset-clearable field, then clears all seven at once', () => {
    bindShellSession(FIRST);
    const app = useAppStore.getState();
    app.setSelection(FIRST, { tag: 'h1', elementId: null });
    app.setCanvasState(FIRST, { url: 'http://project.localhost/' });
    app.setActiveEntry(FIRST, { entryId: 'entry-1' });
    const edit = useEditSessionStore.getState();
    edit.holdGrant(FIRST, { token: 'grant-opaque-1' });
    edit.pushUndo(FIRST, { token: 'undo-opaque-1' });
    edit.scheduleDebounce(FIRST, { key: 'css-rule-1', dueAtMs: 300 });
    edit.trackPendingMutation(FIRST, { key: 'entry-1' });
    expect(shellStoreSnapshot()).toEqual({
      selection: true,
      canvas: true,
      activeEntry: true,
      grants: 1,
      undo: 1,
      debounces: 1,
      pendingMutations: 1,
    });

    clearShellStores();
    expect(shellStoreSnapshot()).toEqual({
      selection: false,
      canvas: false,
      activeEntry: false,
      grants: 0,
      undo: 0,
      debounces: 0,
      pendingMutations: 0,
    });
  });

  it('drops late stale writes after the clear — nothing repopulates', () => {
    bindShellSession(FIRST);
    clearShellStores();
    bindShellSession(NEXT);
    // A stale FIRST-pair write arrives late against the NEXT-bound stores.
    useAppStore.getState().setSelection(FIRST, { tag: 'h1', elementId: null });
    useEditSessionStore.getState().holdGrant(FIRST, { token: 'grant' });
    expect(shellStoreSnapshot().selection).toBe(false);
    expect(shellStoreSnapshot().grants).toBe(0);
  });
});
