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

/** Cross-vertical chrome state; per-vertical state lives in each feature's store. */
interface ChromeState {
  activeVertical: Vertical;
  /** Select mode is default-off and enabled deliberately (spec #2). */
  selectMode: boolean;
  selection: Selection | null;
  setActiveVertical: (vertical: Vertical) => void;
  toggleSelectMode: () => void;
  setSelection: (element: Element) => void;
  clearSelection: () => void;
}

export const useChromeStore = create<ChromeState>()((set) => ({
  activeVertical: 'css',
  selectMode: false,
  selection: null,
  setActiveVertical: (vertical) => set({ activeVertical: vertical }),
  toggleSelectMode: () => set((state) => ({ selectMode: !state.selectMode })),
  setSelection: (element) => set({ selection: { element, descriptor: describeElement(element) } }),
  clearSelection: () => set({ selection: null }),
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
