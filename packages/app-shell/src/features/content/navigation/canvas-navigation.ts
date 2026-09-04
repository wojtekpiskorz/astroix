/**
 * The canvas navigation seam (#251, J1): how feature-driven navigation
 * reaches G3's natural-route same-origin canvas
 * (`canvas/project-canvas.tsx`). The canvas is a PLAIN iframe on the
 * project origin that OBSERVES navigation — it never owns it: its own
 * address control navigates through
 * `frame.contentWindow.location.assign(url)` (the same path an in-page
 * link takes), and every load — whatever caused it — is observed back
 * into the address control and the session-gated canvas state.
 *
 * This seam consumes exactly that path: locate the canvas frame in the
 * shell document (the canvas root's product attribute, never a test
 * id), assign the natural URL on its same-origin `contentWindow`, and
 * fail closed when the frame is absent or unreachable — a navigation
 * the seam cannot perform is reported, never silently dropped or
 * retried.
 *
 * No URL is constructed here: the caller passes the route URL resolved
 * exclusively from the E5 routes payload (the navigation slice's law).
 */

/** What one navigation attempt settled as. */
export type CanvasNavigationOutcome = 'navigated' | 'canvas-unavailable';

/** Locates the canvas frame in the shell document — `null` when absent. */
export type CanvasFrameLocator = () => HTMLIFrameElement | null;

/**
 * The product locator: the canvas root (`data-astroix-canvas`, the
 * frame's own product attribute) and its one iframe. Deliberately NOT
 * a test id — this is a product seam, and `data-astroix-canvas` is the
 * canvas's stable product vocabulary.
 */
export function productCanvasFrameLocator(): HTMLIFrameElement | null {
  const document = globalThis.document;
  if (document === undefined || document === null) return null;
  return document.querySelector('[data-astroix-canvas] iframe');
}

/**
 * Navigates the canvas to `url` — an absolute same-origin URL —
 * through the frame's own location API. Fail closed on every refusal:
 * no frame, an unreachable `contentWindow` (an off-origin document's
 * location read throws), or a rejected assignment all settle
 * `canvas-unavailable`.
 */
export function navigateCanvasFrame(
  url: string,
  locate: CanvasFrameLocator = productCanvasFrameLocator,
): CanvasNavigationOutcome {
  const frame = locate();
  if (frame === null) return 'canvas-unavailable';
  const location = frameWindowLocation(frame);
  if (location === null) return 'canvas-unavailable';
  location.assign(url);
  return 'navigated';
}

/** The frame's same-origin location — `null` when unreachable (fail closed). */
function frameWindowLocation(frame: HTMLIFrameElement): Location | null {
  try {
    return frame.contentWindow?.location ?? null;
  } catch {
    // A cross-origin document's location read throws — the canvas the
    // feature may navigate is unreachable, by law.
    return null;
  }
}
