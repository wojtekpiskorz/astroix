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

/** Which file the editor pane shows, with the matched ranges to jump between. */
export interface EditorSpec {
  file: string;
  ranges: Array<{ start: number; end: number; label: string }>;
  activeIndex: number;
}

interface ChromeState {
  /** Select mode is default-off and enabled deliberately (spec #2). */
  selectMode: boolean;
  selection: Selection | null;
  editor: EditorSpec | null;
  toggleSelectMode: () => void;
  setSelection: (element: Element) => void;
  clearSelection: () => void;
  openEditor: (spec: EditorSpec) => void;
  closeEditor: () => void;
}

export const useChromeStore = create<ChromeState>()((set) => ({
  selectMode: false,
  selection: null,
  editor: null,
  toggleSelectMode: () => set((state) => ({ selectMode: !state.selectMode })),
  setSelection: (element) => set({ selection: { element, descriptor: describeElement(element) } }),
  clearSelection: () => set({ selection: null }),
  openEditor: (spec) => set({ editor: spec }),
  closeEditor: () => set({ editor: null }),
}));
