import { create } from 'zustand';

/** A stable, human-readable descriptor of the selected canvas element. */
export function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const classes = element.classList.length > 0 ? `.${element.classList.item(0)}` : '';
  let nth = 1;
  for (
    let sibling = element.previousElementSibling;
    sibling !== null;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.tagName === element.tagName) nth += 1;
  }
  return `${tag}${classes}:nth-of-type(${nth})`;
}

export interface Selection {
  element: Element;
  descriptor: string;
}

/** The chrome's verticals — the sidebar/editor workbench swaps on this (ADR-0002). */
export type Vertical = 'css' | 'content';

/** A navigation command for the canvas iframe; `seq` makes repeat requests to the same URL re-fire. */
export interface CanvasNav {
  url: string;
  seq: number;
}

/** One canvas load: the URL as of the iframe's `load` event; `seq` is the load's identity — same-URL reloads bump it. */
export interface CanvasLoad {
  url: string;
  seq: number;
}

/** Cross-vertical chrome state; per-vertical state lives in each feature's store. */
interface ChromeState {
  activeVertical: Vertical;
  /** Select mode is default-off and enabled deliberately (spec #2). */
  selectMode: boolean;
  selection: Selection | null;
  /** The canvas iframe's last load — the in-canvas navigation signal (#71). */
  canvasLoad: CanvasLoad | null;
  /** The pending canvas navigation, consumed by the canvas (never cleared — `seq` drives it). */
  canvasNav: CanvasNav | null;
  setActiveVertical: (vertical: Vertical) => void;
  toggleSelectMode: () => void;
  setSelection: (element: Element) => void;
  clearSelection: () => void;
  reportCanvasLoad: (url: string) => void;
  requestCanvasNav: (url: string) => void;
}

export const useChromeStore = create<ChromeState>()((set) => ({
  activeVertical: 'css',
  selectMode: false,
  selection: null,
  canvasLoad: null,
  canvasNav: null,
  setActiveVertical: (vertical) => set({ activeVertical: vertical }),
  toggleSelectMode: () => set((state) => ({ selectMode: !state.selectMode })),
  setSelection: (element) => set({ selection: { element, descriptor: describeElement(element) } }),
  clearSelection: () => set({ selection: null }),
  reportCanvasLoad: (url) =>
    set((state) => ({ canvasLoad: { url, seq: (state.canvasLoad?.seq ?? 0) + 1 } })),
  requestCanvasNav: (url) =>
    set((state) => ({ canvasNav: { url, seq: (state.canvasNav?.seq ?? 0) + 1 } })),
}));

/**
 * Select mode is a property of the CSS vertical (issue #70): off-CSS it stays
 * armed in the store but suspended on the canvas — no hover/selection
 * machinery — and switching back restores it. The ownership lives here, in
 * the cross-vertical state layer, so `canvas/` stays vertical-agnostic.
 */
export function useSelectModeActive(): boolean {
  return useChromeStore((state) => state.selectMode && state.activeVertical === 'css');
}
