import type { DocumentAuthorityPort } from '@wojciechpiskorz/astroix-runtime/client-authority';

/**
 * The main-side document-binding lifecycle (#246, H4): maps the Electron
 * window events onto the runtime document authority's host-driven port
 * — WHEN a binding's document dies (ADR-0006 §3 "Revoked on navigation,
 * renderer loss, debugger detach, or session replacement"; the port
 * owns WHAT that means). Electron-free: the real event names are the
 * harness/composition adapter's business (`did-navigate` is
 * main-frame-only in Electron, so one top-level navigation is one
 * counter tick; `did-navigate-in-page` is deliberately NOT observed — a
 * history pushState keeps the document, and its binding with it).
 *
 * The `navigationId` is minted here — the host's per-`webContents`
 * top-level navigation counter F4's registry law names: monotonic from
 * 1 within one observation, so a bind always names a counter value this
 * module actually observed (the authority's stale-document law then
 * refuses anything older or reordered).
 */

/** The window/webContents event seam — each registration returns its unbind. */
export interface DocumentTargetEventsSeam {
  /** Electron's integer identity of the observed webContents — opaque here. */
  readonly webContentsId: number;
  /** A main-frame navigation completed — a new document exists. */
  onDidNavigate(handler: () => void): () => void;
  /** The renderer process is gone (crash or equivalent kill). */
  onRenderProcessGone(handler: () => void): () => void;
  /** The whole target is destroyed. */
  onDestroyed(handler: () => void): () => void;
}

/** The observation this wiring exposes to its composition. */
export interface DocumentTargetBinding {
  /** The current top-level navigation counter of this target (0 before any navigation). */
  currentNavigationId(): number;
  /** Unbinds every event listener — the port keeps whatever state it already holds. */
  detach(): void;
}

/**
 * Wires one target's lifecycle onto the authority port. Synchronous,
 * order-free registration: every handler drives the port directly, so
 * the invalidation lands before any further control work can consult a
 * dead binding (the port's own sweeps are synchronous).
 */
export function observeDocumentTarget(
  port: DocumentAuthorityPort,
  target: DocumentTargetEventsSeam,
): DocumentTargetBinding {
  let navigationId = 0;
  const unbindDidNavigate = target.onDidNavigate(() => {
    navigationId += 1;
    port.documentNavigated(target.webContentsId, navigationId);
  });
  const unbindRenderGone = target.onRenderProcessGone(() => {
    port.rendererLost(target.webContentsId);
  });
  const unbindDestroyed = target.onDestroyed(() => {
    port.targetDestroyed(target.webContentsId);
  });
  return {
    currentNavigationId: () => navigationId,
    detach: () => {
      unbindDidNavigate();
      unbindRenderGone();
      unbindDestroyed();
    },
  };
}
