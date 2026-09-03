import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useShell } from '../app-shell/shell-context.ts';
import { type CanvasOriginState, useAppStore } from '../state/app-store.ts';
import {
  matchedSelectors,
  rematchSelection,
  type SelectionMatch,
  selectionDescriptorOf,
} from '../state/selection.ts';
import { runtimeRuleSelectors, type StyleSheetLike } from './canvas-rules.ts';

/**
 * The natural-route same-origin canvas (#242, G3; CONTEXT.md "canvas":
 * "the same-origin iframe in the app shell showing the project's live
 * page at its natural URL ... on the active project hostname"): a PLAIN
 * iframe whose document is the project's own page — served by its own
 * dev server through the transparent origin proxy — with nothing of
 * Astroix inside it. Because the shell document and the canvas share
 * the exact project origin, `iframe.contentDocument` is directly
 * accessible, `Element.matches` runs in the canvas's own realm, and
 * the page's own Vite HMR WebSocket rides the proxied native path with
 * no Astroix event bridge (this component adds no transport at all).
 *
 * What the frame owns:
 *
 * - **Natural URLs only** — the iframe loads `origin + initialRoute`
 *   (the resolved base included, never a synthetic canvas path or
 *   builder query) and observes every navigation; URLs are read, never
 *   rewritten.
 * - **Navigation observation** — every document load (a link, an
 *   address navigation, an HMR-triggered full reload) re-derives the
 *   observed URL and the origin state.
 * - **The fail-closed origin gate** — a canvas that navigated off the
 *   project origin stays visible but inspection and editing are
 *   disabled until it returns (the spec's user story 5); before the
 *   first observation the gate is closed too.
 * - **Direct DOM selection** — in selection mode, clicks in the canvas
 *   document are captured (navigation prevented), the element's
 *   re-matchable identity lands in the session-gated app store, and
 *   the element is matched against the document's runtime effective
 *   selectors through `Element.matches` (`state/selection.ts` +
 *   `canvas-rules.ts` — the same matching law the CSS vertical's index
 *   payload will flow through).
 * - **Selection persistence** — the selection is a descriptor, not a
 *   live reference; every load and every HMR style/DOM mutation
 *   re-resolves it against the live document, so eligible reloads and
 *   reindexing keep the selection while the matched list stays true to
 *   whatever the document now says.
 */

/** The debounced re-resolution wait — HMR bursts settle before the pass runs. */
const RECOMPUTE_DELAY_MS = 150;

/** Construction props; the host injects its document facts, tests inject all of them. */
export interface ProjectCanvasProps {
  /**
   * The active project origin the canvas shares with the shell document;
   * defaults to the document's own (`location.origin` — the project
   * document IS served on the project hostname).
   */
  readonly origin?: string;
  /** The initial natural route (the resolved base included); defaults to `/`, the natural root. */
  readonly initialRoute?: string;
}

/** The canvas frame: the control strip, the plain iframe, and the selection surface. */
export function ProjectCanvas({ origin, initialRoute = '/' }: ProjectCanvasProps): ReactNode {
  const documentOrigin = globalThis.location?.origin;
  if (origin === undefined && documentOrigin === undefined) {
    throw new Error('ProjectCanvas needs an origin (prop or its document)');
  }
  const projectOrigin = origin ?? (documentOrigin as string);
  const initialUrl = new URL(initialRoute, projectOrigin).href;
  const { session } = useShell();

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const recomputeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The address input's dirty flag: an observed load must never clobber
  // an address the user typed but has not navigated to yet (the
  // project's own post-connect reloads race in-flight input otherwise).
  const addressDirty = useRef(false);

  const [originState, setOriginState] = useState<CanvasOriginState | 'loading'>('loading');
  const [observedUrl, setObservedUrl] = useState<string | null>(null);
  const [address, setAddress] = useState(initialRoute);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const [selectionMode, setSelectionMode] = useState(true);
  const [matches, setMatches] = useState<readonly SelectionMatch[]>([]);

  const descriptor = useAppStore((state) => state.selection);
  const setSelection = useAppStore((state) => state.setSelection);
  const clearSelection = useAppStore((state) => state.clearSelection);
  const setCanvasState = useAppStore((state) => state.setCanvasState);

  const inspectionEnabled = originState === 'project';

  // The per-document bindings and their helpers: the selection click
  // capture and the mutation-driven re-resolution live on the CURRENT
  // canvas document — every load is a new document, so everything below
  // is scoped to one epoch, inside the effect that owns it.
  // biome-ignore lint/correctness/useExhaustiveDependencies(loadEpoch): the epoch is the document identity the effect rebinds on — a reload of the SAME URL changes no read dependency, and without it the bindings stay on a dead document.
  useEffect(() => {
    if (originState !== 'project') return;
    const canvasDoc = canvasDocument(frameRef.current);
    if (canvasDoc === null) return;

    /** Re-resolves the stored selection against the live document and re-matches its runtime selectors. */
    const resolveSelection = (): void => {
      const current = useAppStore.getState().selection;
      const element = current === null ? null : rematchSelection(canvasDoc, current);
      setMatches(
        element === null
          ? []
          : matchedSelectors(element, runtimeRuleSelectors(sheetsOf(canvasDoc))),
      );
    };

    /** Selects one canvas element: the identity into the store, the matches into the panel. */
    const selectElement = (element: Element): void => {
      setSelection(session.ref, selectionDescriptorOf(element));
      setMatches(matchedSelectors(element, runtimeRuleSelectors(sheetsOf(canvasDoc))));
    };

    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      // Structural, never `instanceof Element`: the canvas document has
      // its own realm — a cross-realm instanceof would drop every
      // target even same-origin.
      const target = event.target;
      if (isElementLike(target)) selectElement(target);
    };
    if (selectionMode) canvasDoc.addEventListener('click', onClick, true);

    /** Debounced mutation pass — one re-resolution after an HMR burst settles. */
    const scheduleRecompute = (): void => {
      if (recomputeTimer.current !== null) clearTimeout(recomputeTimer.current);
      recomputeTimer.current = setTimeout(() => {
        recomputeTimer.current = null;
        resolveSelection();
      }, RECOMPUTE_DELAY_MS);
    };

    const observer = new MutationObserver(scheduleRecompute);
    observer.observe(canvasDoc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    resolveSelection();
    return () => {
      canvasDoc.removeEventListener('click', onClick, true);
      observer.disconnect();
      if (recomputeTimer.current !== null) clearTimeout(recomputeTimer.current);
      recomputeTimer.current = null;
    };
    // loadEpoch is the document identity here: two loads of one URL are
    // still two documents, and the bindings must follow the live one.
  }, [loadEpoch, originState, selectionMode, session, setSelection]);

  /** The load observer: re-derives the URL, the origin state, and the gate. */
  const observeLoad = (): void => {
    const url = canvasLocationHref(frameRef.current);
    const state = originStateOf(url, projectOrigin);
    setOriginState(state);
    setObservedUrl(url);
    setLoadEpoch((epoch) => epoch + 1);
    if (state === 'project' && url !== null) {
      setCanvasState(session.ref, { url, origin: 'project' });
      if (!addressDirty.current) setAddress(new URL(url).pathname);
      return;
    }
    if (state === 'loading') return;
    // Off-origin: the canvas may stay visible, but nothing in it is
    // inspectable or editable — the selection goes now, not lazily.
    setCanvasState(session.ref, { url: null, origin: 'external' });
    clearSelection();
    setMatches([]);
  };

  /** Navigates the canvas to the address input's natural route. */
  const navigateToAddress = (): void => {
    const target = new URL(address, projectOrigin);
    const frame = frameRef.current;
    if (frame === null) return;
    addressDirty.current = false;
    // The page's own navigation when the document is same-origin (the
    // same path an in-page link takes — no attribute mutation at all);
    // the src assignment is the off-origin return's only lever.
    try {
      frame.contentWindow?.location.assign(target.href);
    } catch {
      frame.src = target.href;
    }
  };

  return (
    <div data-astroix-canvas data-astroix-canvas-origin={originState}>
      <div data-astroix-canvas-strip>
        <span data-testid="canvas-origin-state">{originState}</span>
        <span data-testid="canvas-inspection">{inspectionEnabled ? 'enabled' : 'disabled'}</span>
        <button
          type="button"
          data-testid="canvas-selection-mode"
          disabled={!inspectionEnabled}
          aria-pressed={selectionMode}
          onClick={() => {
            setSelectionMode(!selectionMode);
          }}
        >
          selection: {selectionMode ? 'on' : 'off'}
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            navigateToAddress();
          }}
        >
          <input
            data-testid="canvas-address"
            aria-label="canvas route"
            value={address}
            onChange={(event) => {
              addressDirty.current = true;
              setAddress(event.target.value);
            }}
          />
          <button type="submit" data-testid="canvas-navigate">
            Go
          </button>
        </form>
        <p data-testid="canvas-url">{observedUrl ?? ''}</p>
      </div>
      <iframe
        ref={frameRef}
        data-testid="canvas-frame"
        title="the project's live page"
        src={initialUrl}
        onLoad={observeLoad}
      />
      <div data-astroix-canvas-selection>
        <p data-testid="selection-tag">{descriptor === null ? 'none' : descriptor.tag}</p>
        <ul data-testid="selection-matches">
          {matchedRows(matches).map((row) => (
            <li
              key={row.key}
              data-match-selector={row.match.selector}
              data-match-media={row.match.media ?? ''}
            >
              {row.match.selector}
              {row.match.media === null ? null : <small> @media {row.match.media}</small>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Narrows one event target to an element STRUCTURALLY — the canvas
 * document lives in its own realm, so a parent-realm `instanceof
 * Element` is false for every canvas node (same-origin or not).
 */
function isElementLike(target: EventTarget | null): target is Element {
  return (
    target !== null && typeof target === 'object' && 'matches' in target && 'tagName' in target
  );
}

/**
 * Keys the matched rows for rendering: one selector may legitimately
 * occur several times (the same selector in two repo rules — the
 * multi-range case), so the occurrence count within one pass is the
 * duplicate row's identity — never the bare array index.
 */
function matchedRows(matches: readonly SelectionMatch[]): { key: string; match: SelectionMatch }[] {
  const rows: { key: string; match: SelectionMatch }[] = [];
  const seen = new Map<string, number>();
  for (const match of matches) {
    const base = `${match.selector}|${match.media ?? ''}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    rows.push({ key: `${base}#${occurrence}`, match });
  }
  return rows;
}

/** The canvas document, when it is same-origin and reachable — `null` otherwise (fail closed). */
function canvasDocument(frame: HTMLIFrameElement | null): Document | null {
  try {
    return frame?.contentDocument ?? null;
  } catch {
    return null;
  }
}

/** The canvas document's URL — `null` when the document is off-origin (the location read throws). */
function canvasLocationHref(frame: HTMLIFrameElement | null): string | null {
  try {
    return frame?.contentWindow?.location.href ?? null;
  } catch {
    return null;
  }
}

/** Derives the origin state: the project origin, an off-origin document, or the pre-navigation blank. */
function originStateOf(url: string | null, projectOrigin: string): CanvasOriginState | 'loading' {
  if (url === null) return 'external';
  if (url === 'about:blank') return 'loading';
  return new URL(url).origin === projectOrigin ? 'project' : 'external';
}

/** The document's stylesheets as the walk reads them — the live runtime-selector source. */
function sheetsOf(canvasDoc: Document): readonly StyleSheetLike[] {
  const sheets: StyleSheetLike[] = [];
  for (let index = 0; index < canvasDoc.styleSheets.length; index += 1) {
    sheets.push(canvasDoc.styleSheets[index] as CSSStyleSheet);
  }
  return sheets;
}
