import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { clearShellStores } from '../../state/shell-stores.ts';
import { type CssUndoEntry, undoDepth, useCssUndoStore } from './undo.ts';

/**
 * The undo stack's units (#250, I2): the generation-local law — one
 * exact session pair binds the stack, a different pair's push clears
 * it first (the A-to-B-to-A document never sees the old generation's
 * undo), the conflict-reload clear wipes it, and the pop discipline
 * peels strictly from the top.
 */

const SESSION: SessionRef = { runtimeEpoch: 'epoch', generation: 4 };
const OTHER: SessionRef = { runtimeEpoch: 'epoch', generation: 5 };

function entry(key: string): CssUndoEntry {
  return {
    key,
    file: 'src/pages/home.css',
    range: { start: 130, end: 146 },
    replacement: 'font-size: 3rem;',
    replaced: 'font-size: 3.5rem;',
  };
}

afterEach(() => {
  clearShellStores();
  useCssUndoStore.getState().clear();
});

describe('the generation-local undo stack', () => {
  it('binds at one pair and peels strictly from the top', () => {
    useCssUndoStore.getState().bind(SESSION);
    useCssUndoStore.getState().push(SESSION, entry('one'));
    useCssUndoStore.getState().push(SESSION, entry('two'));
    expect(undoDepth()).toBe(2);
    expect(useCssUndoStore.getState().peek()?.key).toBe('two');
    useCssUndoStore.getState().pop(SESSION);
    expect(useCssUndoStore.getState().peek()?.key).toBe('one');
    expect(undoDepth()).toBe(1);
  });

  it('a different pair\u2019s bind clears the stack — A to B to A never resumes it', () => {
    useCssUndoStore.getState().bind(SESSION);
    useCssUndoStore.getState().push(SESSION, entry('one'));
    useCssUndoStore.getState().bind(OTHER);
    expect(undoDepth()).toBe(0);
    // the old pair's late push never lands either
    useCssUndoStore.getState().push(SESSION, entry('late'));
    expect(undoDepth()).toBe(0);
  });

  it('the conflict-reload clear wipes the binding and the entries', () => {
    useCssUndoStore.getState().bind(SESSION);
    useCssUndoStore.getState().push(SESSION, entry('one'));
    useCssUndoStore.getState().clear();
    expect(undoDepth()).toBe(0);
    // a cleared stack accepts no pushes until re-bound
    useCssUndoStore.getState().push(SESSION, entry('late'));
    expect(undoDepth()).toBe(0);
  });
});
