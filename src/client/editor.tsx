import { css as cssLang } from '@codemirror/lang-css';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { useQueryClient } from '@tanstack/react-query';
import { basicSetup } from 'codemirror';
import { useEffect, useRef, useState } from 'react';
import { type EditorSpec, useChromeStore } from './store';

const WRITE_DEBOUNCE_MS = 300;

/** Browser-side sha256 hex of the editor's believed-on-disk content. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Replace the whole document, keeping the cursor where it was (clamped). */
function replaceDoc(view: EditorView, contents: string): void {
  const text = view.state.doc.toString();
  if (contents === text) return;
  const anchor = Math.min(view.state.selection.main.head, contents.length);
  view.dispatch({
    changes: { from: 0, to: text.length, insert: contents },
    selection: { anchor },
  });
}

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

/**
 * The rule editor: CodeMirror over the rule's file, opened scrolled to and
 * highlighting the clicked range; per-range chips jump between the places
 * one file styles the selection. Raw-text editing with a ~300 ms debounced
 * auto-write — each pause sends ONE contiguous edit (common prefix/suffix
 * diff against the last-written snapshot) through the splice endpoint, so
 * everything outside the edit stays byte-identical. No Save button: host
 * HMR is the preview (spec #9).
 */
export function EditorPane() {
  const editor = useChromeStore((state) => state.editor);
  if (editor === null) {
    return (
      <div
        data-astroix-editor="empty"
        className="flex w-[480px] shrink-0 items-center justify-center border-r border-slate-800 bg-slate-950 text-xs text-slate-600"
      >
        Click a rule to edit its file.
      </div>
    );
  }
  return <RuleEditor key={editor.file} spec={editor} />;
}

function RuleEditor({ spec }: { spec: EditorSpec }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const baselineRef = useRef<string>('');
  const [status, setStatus] = useState<
    'loading' | 'idle' | 'pending' | 'saved' | 'stale' | 'error'
  >('loading');
  const [activeIndex, setActiveIndex] = useState(spec.activeIndex);
  const queryClient = useQueryClient();
  const closeEditor = useChromeStore((state) => state.closeEditor);

  useEffect(() => {
    let cancelled = false;
    let view: EditorView | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const range = spec.ranges[spec.activeIndex];

    /** External content won: reload it into the doc and rebase. */
    const acceptExternal = (contents: string): void => {
      if (view === null) return;
      replaceDoc(view, contents);
      baselineRef.current = contents;
      setStatus('stale');
      void queryClient.invalidateQueries({ queryKey: ['astroix', 'index-payload'] });
    };

    const write = async (text: string): Promise<void> => {
      const baseline = baselineRef.current;
      // one contiguous edit per pause: common prefix/suffix around the change
      let start = 0;
      while (start < baseline.length && start < text.length && baseline[start] === text[start]) {
        start += 1;
      }
      let endBaseline = baseline.length;
      let endText = text.length;
      while (
        endBaseline > start &&
        endText > start &&
        baseline[endBaseline - 1] === text[endText - 1]
      ) {
        endBaseline -= 1;
        endText -= 1;
      }
      if (start === endBaseline && start === endText) {
        setStatus('idle');
        return;
      }
      const response = await fetch('/__astroix/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: spec.file,
          range: { start, end: endBaseline },
          replacement: text.slice(start, endText),
          // optimistic write: what we believe is on disk — a mismatch means
          // the file changed under us (IDE edit racing the debounce)
          expected: await sha256Hex(baseline),
        }),
      });
      if (response.status === 409) {
        // the disk moved first: reload its content instead of splicing stale
        // offsets into a shifted file (the typed edit is dropped — the diff
        // UI is v1)
        const body = (await response.json()) as { contents?: string };
        if (typeof body.contents === 'string') acceptExternal(body.contents);
        else setStatus('error');
        return;
      }
      if (response.ok) {
        baselineRef.current = text;
        setStatus('saved');
        // the payload's ranges are stale after any write — refetch
        void queryClient.invalidateQueries({ queryKey: ['astroix', 'index-payload'] });
      } else {
        setStatus('error');
      }
    };

    void (async () => {
      const response = await fetch(`/__astroix/file?file=${encodeURIComponent(spec.file)}`);
      if (!response.ok) {
        setStatus('error');
        return;
      }
      const { contents } = (await response.json()) as { contents: string };
      if (cancelled || hostRef.current === null) return;
      baselineRef.current = contents;

      view = new EditorView({
        doc: contents,
        extensions: [
          basicSetup,
          cssLang(),
          activeRangeField,
          editorTheme,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            setStatus('pending');
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => {
              void write(view?.state.doc.toString() ?? '');
            }, WRITE_DEBOUNCE_MS);
          }),
        ],
        parent: hostRef.current,
      });
      // stash for e2e and future tooling: dispatching through the real view
      // exercises the same change path as typing
      (view.dom as HTMLDivElement & { __astroixView?: EditorView }).__astroixView = view;

      if (range !== undefined) {
        view.dispatch({
          effects: [
            setActiveRange.of({ start: range.start, end: range.end }),
            EditorView.scrollIntoView(range.start, { y: 'center' }),
          ],
          selection: { anchor: range.start },
          scrollIntoView: true,
        });
      }
      setStatus('idle');
    })();

    // file→chrome sync (spec #13): the node watcher pushes
    // `astroix:file-changed` over the Vite WS. Our own writes echo back as
    // no-ops (content compare); a genuinely external change replaces the doc
    // when it is clean — while dirty, the pending write reconciles (and the
    // expected-hash guard turns a race into a reload, never a corruption).
    const onFileSync = (payload: { file: string }): void => {
      if (payload.file !== spec.file || view === null || cancelled) return;
      void (async () => {
        const response = await fetch(`/__astroix/file?file=${encodeURIComponent(spec.file)}`);
        if (!response.ok || cancelled) return;
        const { contents } = (await response.json()) as { contents: string };
        const doc = view?.state.doc.toString() ?? '';
        if (contents === doc) return; // echo of our own write
        if (doc === baselineRef.current) {
          replaceDoc(view as EditorView, contents);
          baselineRef.current = contents;
        }
        // dirty doc: the debounce will write (hash-guarded) — never clobber
      })();
    };
    if (import.meta.hot) {
      import.meta.hot.on('astroix:file-changed', onFileSync);
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (import.meta.hot) import.meta.hot.off('astroix:file-changed', onFileSync);
      view?.destroy();
    };
    // mounts once per file (keyed); spec identity is stable while open
  }, [spec, queryClient]);

  const jumpTo = (index: number): void => {
    setActiveIndex(index);
    const host = hostRef.current?.querySelector<HTMLElement>('.cm-editor');
    const view = (host as (HTMLElement & { __astroixView?: EditorView }) | null)?.__astroixView;
    const range = spec.ranges[index];
    if (view === undefined || range === undefined) return;
    view.dispatch({
      effects: [
        setActiveRange.of({ start: range.start, end: range.end }),
        EditorView.scrollIntoView(range.start, { y: 'center' }),
      ],
      selection: { anchor: range.start },
      scrollIntoView: true,
    });
  };

  return (
    <div
      data-astroix-editor="view"
      className="flex w-[480px] shrink-0 flex-col border-r border-slate-800 bg-slate-950"
    >
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-xs">
        <code className="truncate text-slate-300">{spec.file}</code>
        <span
          data-astroix-editor-status={status}
          className={
            status === 'saved'
              ? 'text-emerald-400'
              : status === 'pending'
                ? 'text-amber-400'
                : status === 'stale'
                  ? 'text-amber-400'
                  : status === 'error'
                    ? 'text-red-400'
                    : 'text-slate-500'
          }
        >
          {status === 'saved'
            ? 'written'
            : status === 'pending'
              ? 'writing…'
              : status === 'stale'
                ? 'changed on disk — reloaded'
                : status}
        </span>
        <button
          type="button"
          onClick={closeEditor}
          aria-label="close editor"
          className="ml-auto rounded px-1 text-slate-500 hover:bg-slate-800"
        >
          ×
        </button>
      </div>
      {spec.ranges.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-slate-800 px-3 py-1.5">
          {spec.ranges.map((r, index) => (
            <button
              type="button"
              key={r.label}
              data-astroix-range-chip={index}
              aria-pressed={index === activeIndex}
              onClick={() => jumpTo(index)}
              className={
                index === activeIndex
                  ? 'rounded bg-sky-500 px-1.5 py-0.5 text-[10px] font-medium text-slate-950'
                  : 'rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400'
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
