import { css as cssLang } from '@codemirror/lang-css';
import { EditorView } from '@codemirror/view';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { fetchFileContents, putFileRangeEdit } from '../../editor/api';
import { createEditorView, replaceDoc, revealRange } from '../../editor/codemirror';
import { INDEX_PAYLOAD_KEY } from './api';
import { type EditorSpec, useCssStore } from './store';

const WRITE_DEBOUNCE_MS = 300;

/**
 * The rule editor: CodeMirror over the rule's file, opened scrolled to and
 * highlighting the clicked range; per-range chips jump between the places
 * one file styles the selection. Raw-text editing with a ~300 ms debounced
 * auto-write — each pause sends ONE contiguous edit (common prefix/suffix
 * diff against the last-written snapshot) through the splice endpoint, so
 * everything outside the edit stays byte-identical. No Save button: host
 * HMR is the preview (spec #9).
 */
export function RuleEditor({ spec }: { spec: EditorSpec }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const baselineRef = useRef<string>('');
  const [status, setStatus] = useState<
    'loading' | 'idle' | 'pending' | 'saved' | 'stale' | 'error'
  >('loading');
  const [activeIndex, setActiveIndex] = useState(spec.activeIndex);
  const queryClient = useQueryClient();
  const closeEditor = useCssStore((state) => state.closeEditor);

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
      void queryClient.invalidateQueries({ queryKey: INDEX_PAYLOAD_KEY });
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
      const result = await putFileRangeEdit({
        file: spec.file,
        // optimistic write: what we believe is on disk — a mismatch means
        // the file changed under us (IDE edit racing the debounce)
        baseline,
        range: { start, end: endBaseline },
        replacement: text.slice(start, endText),
      });
      if (result.status === 'conflict') {
        // the disk moved first: reload its content instead of splicing stale
        // offsets into a shifted file (the typed edit is dropped — the diff
        // UI is v1)
        if (result.contents !== null) acceptExternal(result.contents);
        else setStatus('error');
        return;
      }
      if (result.status === 'written') {
        baselineRef.current = text;
        setStatus('saved');
        // the payload's ranges are stale after any write — refetch
        void queryClient.invalidateQueries({ queryKey: INDEX_PAYLOAD_KEY });
      } else {
        setStatus('error');
      }
    };

    void (async () => {
      const contents = await fetchFileContents(spec.file);
      if (contents === null) {
        setStatus('error');
        return;
      }
      if (cancelled || hostRef.current === null) return;
      baselineRef.current = contents;

      view = createEditorView({
        doc: contents,
        parent: hostRef.current,
        extensions: [
          cssLang(),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            setStatus('pending');
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => {
              void write(view?.state.doc.toString() ?? '');
            }, WRITE_DEBOUNCE_MS);
          }),
        ],
      });

      if (range !== undefined) {
        revealRange(view, range);
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
        const contents = await fetchFileContents(spec.file);
        if (contents === null || cancelled) return;
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
    revealRange(view, range);
  };

  return (
    <div data-astroix-editor="view" className="flex min-h-0 flex-1 flex-col">
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
