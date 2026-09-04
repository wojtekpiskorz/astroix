import type { SelectionDescriptor } from '../../../state/selection.ts';
import { rematchSelection } from '../../../state/selection.ts';

/**
 * The CSS vertical's read-side consumption of the canvas surface
 * (#249, I1): the canvas frame is shell-owned (#242, G3 — the frame,
 * the click capture, the navigation observation), and the ONE disclosed
 * matching seam is `matchedSelectors`/`rematchSelection` plus the
 * selection identity (the shell barrel's own export law). This module
 * is the CSS feature's entire reach into that surface: it resolves the
 * LIVE canvas document through the canvas frame's stable mount
 * (`iframe[data-testid="canvas-frame"]`, the same testid the canvas
 * battery pins — the frame's public shape, never its internals) and
 * re-finds the selected element through the disclosed `rematchSelection`
 * law, so `Element.matches` runs in the canvas document's own realm
 * exactly as the canvas's own selection pass does.
 *
 * Fail-closed throughout: a cross-origin or missing frame, a destroyed
 * document, or a descriptor the rebuilt DOM no longer carries answers
 * `null` — the panel's honest "the selected element is no longer in the
 * canvas" state, never a crash and never a synthesized element.
 */

/** The canvas frame's stable mount selector — G3's landed surface shape. */
export const CANVAS_FRAME_SELECTOR = 'iframe[data-testid="canvas-frame"]';

/**
 * The live canvas document, when the frame is in THIS document and
 * same-origin readable — `null` otherwise (fail closed; an off-origin
 * canvas is the app store's `external` truth, already gated upstream).
 */
export function canvasDocument(): Document | null {
  const frame = document.querySelector(CANVAS_FRAME_SELECTOR);
  if (frame === null) return null;
  try {
    return (frame as HTMLIFrameElement).contentDocument ?? null;
  } catch {
    return null;
  }
}

/**
 * Re-finds the selected element in the live canvas document — the
 * disclosed re-match law. `null` when the canvas document is
 * unreachable or the descriptor no longer finds an element (the
 * missing-element truth the panel clears on).
 */
export function selectedCanvasElement(descriptor: SelectionDescriptor): Element | null {
  const doc = canvasDocument();
  if (doc === null) return null;
  return rematchSelection(doc, descriptor);
}

/**
 * Subscribes to the canvas document's own mutations — the CSS slice's
 * re-derivation trigger for DOM changes the styles payload does not
 * carry (an HMR rebuild that removes or reshapes the selected element).
 * The frame's own loads are observed too: every load is a new document,
 * so the observer follows the live one. The listener fires debounced
 * (HMR bursts settle before one pass), and the returned unsubscribe
 * stops everything it started.
 */
export function subscribeCanvasMutations(listener: () => void): () => void {
  const frame = document.querySelector(CANVAS_FRAME_SELECTOR);
  if (frame === null) return () => {};
  const debounce = 150;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;
  const stop = (): void => {
    observer?.disconnect();
    observer = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      listener();
    }, debounce);
  };
  const attach = (): void => {
    observer?.disconnect();
    const doc = canvasDocument();
    if (doc === null || doc.documentElement === null) return;
    observer = new MutationObserver(schedule);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  };
  attach();
  frame.addEventListener('load', attach);
  return () => {
    frame.removeEventListener('load', attach);
    stop();
  };
}
