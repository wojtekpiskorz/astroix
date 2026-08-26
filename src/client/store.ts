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

interface ChromeState {
  /** Select mode is default-off and enabled deliberately (spec #2). */
  selectMode: boolean;
  selection: Selection | null;
  toggleSelectMode: () => void;
  setSelection: (element: Element) => void;
  clearSelection: () => void;
}

export const useChromeStore = create<ChromeState>()((set) => ({
  selectMode: false,
  selection: null,
  toggleSelectMode: () => set((state) => ({ selectMode: !state.selectMode })),
  setSelection: (element) => set({ selection: { element, descriptor: describeElement(element) } }),
  clearSelection: () => set({ selection: null }),
}));
