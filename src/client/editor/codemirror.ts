import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';

const setActiveRange = StateEffect.define<{ start: number; end: number } | null>();

const activeRangeField = StateField.define<{
  range: { start: number; end: number } | null;
  decorations: DecorationSet;
}>({
  create() {
    return { range: null, decorations: Decoration.none };
  },
  update(value, transaction) {
    let range = value.range;
    for (const effect of transaction.effects) {
      if (effect.is(setActiveRange)) range = effect.value;
    }
    if (range === null || transaction.docChanged) {
      // after edits the recorded range drifts — drop stale highlights (POC)
      return { range, decorations: Decoration.none };
    }
    const decorations = Decoration.set([
      Decoration.mark({ class: 'astroix-rule-highlight' }).range(range.start, range.end),
    ]);
    return { range, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: '#020617' },
  '.cm-scroller': { fontFamily: 'ui-monospace, monospace' },
  '.cm-gutters': { backgroundColor: '#020617', color: '#475569', border: 'none' },
  '.astroix-rule-highlight': {
    backgroundColor: 'rgba(245, 158, 11, 0.18)',
    outline: '1px solid rgba(245, 158, 11, 0.6)',
  },
});

/** Replace the whole document, keeping the cursor where it was (clamped). */
export function replaceDoc(view: EditorView, contents: string): void {
  const text = view.state.doc.toString();
  if (contents === text) return;
  const anchor = Math.min(view.state.selection.main.head, contents.length);
  view.dispatch({
    changes: { from: 0, to: text.length, insert: contents },
    selection: { anchor },
  });
}

/** Focus a range: highlight it, scroll it to the center and place the caret
 *  at its start (used on open and on range-chip jumps). */
export function revealRange(view: EditorView, range: { start: number; end: number }): void {
  view.dispatch({
    effects: [
      setActiveRange.of({ start: range.start, end: range.end }),
      EditorView.scrollIntoView(range.start, { y: 'center' }),
    ],
    selection: { anchor: range.start },
    scrollIntoView: true,
  });
}

/**
 * Shared view construction: base setup + the range-highlight field + the
 * chrome theme, with the caller's extensions (language, listeners) composed
 * between the setup and the theme. Stashes the view for e2e and future
 * tooling: dispatching through the real view exercises the same change path
 * as typing.
 */
export function createEditorView(options: {
  doc: string;
  parent: HTMLElement;
  extensions: Extension[];
}): EditorView {
  const view = new EditorView({
    doc: options.doc,
    extensions: [basicSetup, ...options.extensions, activeRangeField, editorTheme],
    parent: options.parent,
  });
  (view.dom as HTMLDivElement & { __astroixView?: EditorView }).__astroixView = view;
  return view;
}
