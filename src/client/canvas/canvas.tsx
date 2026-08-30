import { useEffect, useRef } from 'react';
import { useChromeStore, useSelectModeActive } from '../store';

const SELECTION_STYLE_ID = 'astroix-selection-style';
const HOVER_CLASS = 'astroix-hover';
const SELECTED_CLASS = 'astroix-selected';
// the chrome-URL param carrying the canvas position (#110) — the owner's
// pick, consistent with the `builder`/`astroix_smoke` param family
const CANVAS_PARAM = 'canvas';

/** The clean-page twin of the given path (client-side twin of canvasUrl). */
function canvasHref(path: string): string {
  const url = new URL(path, window.location.href);
  url.searchParams.set('builder', '0');
  return `${url.pathname}${url.search}`;
}

/** The iframe URL reduced to its shareable position: path + search, the builder marker stripped. */
function canvasPosition(url: string): string {
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.delete('builder');
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Mirrors the canvas position into the chrome URL (#110): replaceState, never
 * pushState — the back button must not fill with canvas positions — and only
 * the param rides along; the chrome page's own path is never rewritten.
 */
export function reflectCanvasPosition(url: string): void {
  const chromeUrl = new URL(window.location.href);
  chromeUrl.searchParams.set(CANVAS_PARAM, canvasPosition(url));
  history.replaceState(null, '', chromeUrl);
}

/** The clean-page twin of the current builder URL — the iframe's boot target. */
function canvasSrc(): string {
  // boot precedence (#110): a carried position wins over deriving from the
  // chrome page's own URL — a refresh or shared link re-opens the canvas
  // where it was; an absent param keeps today's derivation
  const carried = new URL(window.location.href).searchParams.get(CANVAS_PARAM);
  return canvasHref(carried ?? window.location.href);
}

// boot-only: parsed once at module load, before any render (the
// SIDEBAR_OPEN_AT_BOOT idiom). The mirror below rewrites the chrome URL on
// every canvas load, so re-deriving the src mid-render drifts the computed
// value after any navigation — today the React Compiler's prop memoization
// masks the drift (verified: no reload with a per-render derivation), but
// boot precedence is boot semantics: the param is read exactly once, by
// construction rather than compiler grace.
const CANVAS_BOOT_SRC = canvasSrc();

export function Canvas() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // gated by the active vertical (issue #70): suspended while the Content
  // tab is active, restored on return — the effect below does both
  const selectMode = useSelectModeActive();
  const setSelection = useChromeStore((state) => state.setSelection);
  // #71: the canvas reports its URL on every load (the navigation signal
  // route resolution listens to) and applies navigation commands from the
  // store — URL in, URL out, no vertical knowledge
  const reportCanvasLoad = useChromeStore((state) => state.reportCanvasLoad);
  const canvasNav = useChromeStore((state) => state.canvasNav);
  // #141: the iframe's document is replaced on every navigation — store
  // command, in-canvas link, HMR full-reload. The load report is the
  // document-identity signal: the select handlers below re-attach per
  // document, or a reload leaves the live canvas listener-less and clicks
  // pass through unselected
  const canvasLoad = useChromeStore((state) => state.canvasLoad);

  useEffect(() => {
    if (canvasNav === null) return;
    const iframe = iframeRef.current;
    if (iframe === null) return;
    iframe.src = canvasHref(canvasNav.url);
  }, [canvasNav]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: canvasLoad is the document-identity trigger — the body reads contentDocument, which a new load swaps (#141)
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
    // canvasLoad in the deps: a new load is a new document — the handlers
    // must follow it or a reload leaves the live canvas listener-less (#141)
  }, [selectMode, setSelection, canvasLoad]);

  return (
    <div className="min-w-0 flex-1 bg-white">
      <iframe
        id="astroix-canvas"
        ref={iframeRef}
        src={CANVAS_BOOT_SRC}
        title="astroix canvas"
        className="h-full w-full border-0"
        // same-origin: the location is readable, and every navigation —
        // initial load, in-canvas link, store command, sync reload — fires
        // here; the report bumps the load seq even for a same-URL reload
        onLoad={() => {
          const href = iframeRef.current?.contentWindow?.location.href;
          if (href !== undefined) reportCanvasLoad(href);
        }}
      />
    </div>
  );
}
