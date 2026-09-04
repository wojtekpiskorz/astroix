import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { useAppStore } from './app-store.ts';
import { useEditSessionStore } from './edit-session-store.ts';

/**
 * The shell stores' aggregate (#241, G2): one bind, one clear, one
 * snapshot over the app store and the edit-session store — the surface
 * the shell provider (session adoption) and the reset sequencer (the
 * `clear-stores` step) consume. Store-singleton state by doctrine
 * (ADR-0002: the app-level store is importable from anywhere), so the
 * aggregate is module-level functions, not instances. The FEATURE
 * stores are not here: they register with the feature-store reset
 * registry (#372), which the sequencer's clear-stores action walks
 * right after this aggregate's `clearShellStores`.
 */

/** The reset-clearable session state's observable snapshot — the shell-state marker's source of truth. */
export interface ShellStoreSnapshot {
  readonly selection: boolean;
  readonly canvas: boolean;
  readonly activeEntry: boolean;
  readonly grants: number;
  readonly undo: number;
}

/** Binds every shell store at one exact pair (the provider, at session adoption). */
export function bindShellSession(ref: SessionRef): void {
  useAppStore.getState().bindSession(ref);
  useEditSessionStore.getState().bindSession(ref);
}

/**
 * Clears every shell store — the reset's `clear-stores` step. Clears
 * unbind too: a store with `session === null` drops every write, so a
 * stale response resolving after the reset cannot repopulate anything.
 */
export function clearShellStores(): void {
  useAppStore.getState().clear();
  useEditSessionStore.getState().clear();
}

/** The stores' current snapshot — counts and presence, never contents. */
export function shellStoreSnapshot(): ShellStoreSnapshot {
  const app = useAppStore.getState();
  const edit = useEditSessionStore.getState();
  return {
    selection: app.selection !== null,
    canvas: app.canvas !== null,
    activeEntry: app.activeEntry !== null,
    grants: edit.grants.length,
    undo: edit.undo.length,
  };
}
