import { useEffect, useRef } from 'react';
import { useChromeStore, useSelectModeActive } from '../store';

const SELECTION_STYLE_ID = 'astroix-selection-style';
const HOVER_CLASS = 'astroix-hover';
const SELECTED_CLASS = 'astroix-selected';

/** The clean-page twin of the given path (client-side twin of canvasUrl). */
function canvasHref(path: string): string {
  const url = new URL(path, window.location.href);
  url.searchParams.set('builder', '0');
  return `${url.pathname}${url.search}`;
}

/** The clean-page twin of the current builder URL — the iframe's boot target. */
function canvasSrc(): string {
  return canvasHref(window.location.href);
}

export function Canvas() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // gated by the active vertical (issue #70): suspended while the Content
  // tab is active, restored on return — the effect below does both
  const selectMode = useSelectModeActive();
  const setSelection = useChromeStore((state) => state.setSelection);
  // #71: the canvas reports its URL on every load (the navigation signal
  // route resolution listens to) and applies navigation commands from the
  // store — URL in, URL out, no vertical knowledge
  const setCanvasUrl = useChromeStore((state) => state.setCanvasUrl);
  const canvasNav = useChromeStore((state) => state.canvasNav);

  useEffect(() => {
    if (canvasNav === null) return;
    const iframe = iframeRef.current;
    if (iframe === null) return;
    iframe.src = canvasHref(canvasNav.url);
  }, [canvasNav]);

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
        // same-origin: the location is readable, and every navigation —
        // initial load, in-canvas link, store command, sync reload — fires here
        onLoad={() => {
          const href = iframeRef.current?.contentWindow?.location.href;
          if (href !== undefined) setCanvasUrl(href);
        }}
      />
    </div>
  );
}
