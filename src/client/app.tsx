import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useChromeStore } from './store';

interface PayloadRecord {
  selector: string;
  file: string;
}

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
  return (
    <div className="flex h-full w-full flex-col bg-slate-950 text-slate-100">
      <ChromeHeader />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
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
      <button
        type="button"
        onClick={toggleSelectMode}
        aria-pressed={selectMode}
        className={
          selectMode
            ? 'rounded bg-sky-500 px-2 py-0.5 font-medium text-slate-950'
            : 'rounded bg-slate-700 px-2 py-0.5 text-slate-300'
        }
      >
        Select: {selectMode ? 'on' : 'off'}
      </button>
      <span data-astroix-selection className="truncate text-slate-400">
        {selection === null ? 'no selection' : selection.descriptor}
      </span>
    </header>
  );
}

function Sidebar() {
  const { data } = useQuery({
    queryKey: ['astroix', 'index-payload'],
    queryFn: async (): Promise<PayloadRecord[]> => {
      const response = await fetch('/__astroix/index');
      if (!response.ok) return [];
      return (await response.json()) as PayloadRecord[];
    },
  });
  const count = data?.length ?? null;

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 border-r border-slate-800 p-4 text-sm">
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
      <p className="mt-auto text-xs text-slate-600">
        Panels (rule list, editor) mount here in later slices.
      </p>
    </aside>
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
