import { create } from 'zustand';

/** Which file the editor pane shows, with the matched ranges to jump between. */
export interface EditorSpec {
  file: string;
  ranges: Array<{ start: number; end: number; label: string }>;
  activeIndex: number;
}

interface CssState {
  editor: EditorSpec | null;
  openEditor: (spec: EditorSpec) => void;
  closeEditor: () => void;
}

export const useCssStore = create<CssState>()((set) => ({
  editor: null,
  openEditor: (spec) => set({ editor: spec }),
  closeEditor: () => set({ editor: null }),
}));
