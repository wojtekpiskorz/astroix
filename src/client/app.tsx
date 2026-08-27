import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { type IndexPayloadRecord, matchRules } from '../core/matcher';
import { Button } from './components/ui/button';
import { EditorPane } from './editor';
import { type Selection, useChromeStore } from './store';

const SELECTION_STYLE_ID = 'astroix-selection-style';
const HOVER_CLASS = 'astroix-hover';
const SELECTED_CLASS = 'astroix-selected';

/** The clean-page twin of the current builder URL (client-side twin of canvasUrl). */
function canvasSrc(): string {
  const url = new URL(window.location.href);
  url.searchParams.set('builder', '0');
  return `${url.pathname}${url.search}`;
}

export function App() {
  // file→chrome sync (spec #13): any pushed source change makes the payload
  // stale (ranges/lines moved) — refetch on every event, editor or not
  const queryClient = useQueryClient();
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const handler = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['astroix', 'index-payload'] });
    };
    hot.on('astroix:file-changed', handler);
    return () => hot.off('astroix:file-changed', handler);
  }, [queryClient]);

  return (
    // `dark`: the shadcn theme block (.dark in chrome.css) — the foundation
    // components style themselves from these tokens (issue #44)
    <div className="dark flex h-full w-full flex-col bg-slate-950 text-slate-100">
      <ChromeHeader />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <EditorPane />
        <Canvas />
      </div>
    </div>
  );
}

function ChromeHeader() {
  const { selectMode, toggleSelectMode, selection } = useChromeStore();
  return (
    <header
      data-astroix-header=""
      className="flex items-center gap-4 border-b border-slate-800 bg-slate-900 px-4 py-2 text-sm"
    >
      <strong className="translate-x-2 text-xs tracking-widest uppercase">astroix</strong>
      <Button
        type="button"
        variant={selectMode ? 'default' : 'secondary'}
        size="sm"
        onClick={toggleSelectMode}
        aria-pressed={selectMode}
      >
        Select: {selectMode ? 'on' : 'off'}
      </Button>
      <span data-astroix-selection className="truncate text-slate-400">
        {selection === null ? 'no selection' : selection.descriptor}
      </span>
    </header>
  );
}

function Sidebar() {
  const selection = useChromeStore((state) => state.selection);
  const { data, refetch } = useQuery({
    queryKey: ['astroix', 'index-payload'],
    queryFn: async (): Promise<IndexPayloadRecord[]> => {
      const response = await fetch('/__astroix/index');
      if (!response.ok) return [];
      return (await response.json()) as IndexPayloadRecord[];
    },
  });
  // The module-graph join is only complete once the canvas page's style
  // modules are loaded — the initial fetch can race that. Refetch on
  // selection (the charter's "refetch on demand" line).
  useEffect(() => {
    if (selection !== null) void refetch();
  }, [selection, refetch]);
  const count = data?.length ?? null;

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-800 p-4 text-sm">
      <section className="text-slate-400">
        <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
          Index
        </h2>
        {count === null ? (
          <p data-astroix-index="loading">loading…</p>
        ) : count === 0 ? (
          <p data-astroix-index="empty">no indexed rules</p>
        ) : (
          <p data-astroix-index="ready">{count} rules indexed</p>
        )}
      </section>
      <RuleList payload={data} selection={selection} />
      <p className="mt-auto text-xs text-slate-600">The rule editor mounts below the list next.</p>
    </aside>
  );
}

/**
 * The rule list: on selection, the matcher runs over the index payload
 * against the canvas element (its own document context). Presentation shows
 * source-space selectors — the cid hash lives only in effective selectors
 * and is never displayed.
 */
function RuleList({
  payload,
  selection,
}: {
  payload: IndexPayloadRecord[] | undefined;
  selection: Selection | null;
}) {
  const openEditor = useChromeStore((state) => state.openEditor);
  if (selection === null) {
    return (
      <section data-astroix-rules="no-selection" className="text-slate-500">
        <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
          Rules
        </h2>
        <p>Select an element to see its rules.</p>
      </section>
    );
  }
  if (payload === undefined) {
    return (
      <section data-astroix-rules="loading" className="text-slate-500">
        <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
          Rules
        </h2>
        <p>loading…</p>
      </section>
    );
  }

  const matches = matchRules(payload, selection.element);
  if (matches.length === 0) {
    return (
      <section data-astroix-rules="empty" className="text-slate-500">
        <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
          Rules
        </h2>
        <p>No matching rules for this element.</p>
      </section>
    );
  }

  const placesPerFile = new Map<string, number>();
  for (const match of matches) {
    placesPerFile.set(match.record.file, (placesPerFile.get(match.record.file) ?? 0) + 1);
  }

  const openRule = (match: (typeof matches)[number]): void => {
    // the editor shows the whole file; the chips jump between every place
    // that file styles the current selection
    const fileMatches = matches.filter((m) => m.record.file === match.record.file);
    openEditor({
      file: match.record.file,
      ranges: fileMatches.map((m) => ({
        start: m.record.range.start,
        end: m.record.range.end,
        label: `L${m.record.line}`,
      })),
      activeIndex: fileMatches.indexOf(match),
    });
  };

  return (
    <section data-astroix-rules="list">
      <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">Rules</h2>
      <ul className="flex flex-col gap-1.5">
        {matches.map((match) => {
          const multiPlace = (placesPerFile.get(match.record.file) ?? 0) > 1;
          return (
            <li
              key={`${match.record.file}:${match.record.range.start}`}
              data-astroix-rule=""
              data-astroix-winner={match.winner ? 'true' : undefined}
              className={
                match.winner
                  ? 'rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1'
                  : 'rounded border border-slate-800 px-2 py-1'
              }
            >
              <button
                type="button"
                onClick={() => openRule(match)}
                className="block w-full text-left"
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {match.winner && (
                    <span role="img" aria-label="cascade winner" title="cascade winner">
                      ★
                    </span>
                  )}
                  <code className="text-xs text-sky-300">{match.record.selector}</code>
                  {match.record.media !== null && (
                    <span
                      data-astroix-media={match.record.media}
                      className="rounded bg-slate-800 px-1 text-[10px] text-slate-400"
                    >
                      {match.record.media}
                    </span>
                  )}
                  {multiPlace && (
                    <span
                      data-astroix-multi=""
                      className="rounded bg-slate-800 px-1 text-[10px] text-slate-400"
                    >
                      multi-place
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500">
                  {match.record.file}:{match.record.line}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Canvas() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const selectMode = useChromeStore((state) => state.selectMode);
  const setSelection = useChromeStore((state) => state.setSelection);

  useEffect(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!selectMode || !doc) return;

    const style = doc.createElement('style');
    style.id = SELECTION_STYLE_ID;
    style.textContent =
      `.${HOVER_CLASS}{outline:2px solid #38bdf8;outline-offset:1px}` +
      `.${SELECTED_CLASS}{outline:2px solid #f59e0b;outline-offset:1px}`;
    doc.head.append(style);

    let hovered: Element | null = null;
    // `instanceof Element` is realm-bound: canvas elements belong to the
    // iframe's realm, not the chrome's — duck-type by nodeType instead.
    const isElement = (value: EventTarget | null): value is Element =>
      value !== null && (value as Element).nodeType === 1;
    const onOver = (event: Event): void => {
      if (!isElement(event.target)) return;
      hovered?.classList.remove(HOVER_CLASS);
      hovered = event.target;
      event.target.classList.add(HOVER_CLASS);
    };
    // Capture phase + stopImmediatePropagation: while selecting, the click is
    // ours — the canvas page must not react (follow links, submit, navigate).
    const onClick = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isElement(event.target)) {
        for (const el of doc.querySelectorAll(`.${SELECTED_CLASS}`)) {
          el.classList.remove(SELECTED_CLASS);
        }
        event.target.classList.add(SELECTED_CLASS);
        setSelection(event.target);
      }
    };

    doc.addEventListener('mouseover', onOver, true);
    doc.addEventListener('click', onClick, true);
    return () => {
      doc.removeEventListener('mouseover', onOver, true);
      doc.removeEventListener('click', onClick, true);
      // select mode off = the canvas passes through untouched: strip every
      // overlay class we painted (the store keeps the selection itself)
      for (const el of doc.querySelectorAll(`.${HOVER_CLASS}, .${SELECTED_CLASS}`)) {
        el.classList.remove(HOVER_CLASS);
        el.classList.remove(SELECTED_CLASS);
      }
      style.remove();
    };
  }, [selectMode, setSelection]);

  return (
    <div className="min-w-0 flex-1 bg-white">
      <iframe
        id="astroix-canvas"
        ref={iframeRef}
        src={canvasSrc()}
        title="astroix canvas"
        className="h-full w-full border-0"
      />
    </div>
  );
}
