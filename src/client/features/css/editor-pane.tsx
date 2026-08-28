import { RuleEditor } from './rule-editor';
import { useCssStore } from './store';

export function EditorPane() {
  const editor = useCssStore((state) => state.editor);
  if (editor === null) {
    return (
      <div
        data-astroix-editor="empty"
        className="flex w-[480px] shrink-0 items-center justify-center border-r border-slate-800 bg-slate-950 text-xs text-slate-600"
      >
        Click a rule to edit its file.
      </div>
    );
  }
  return <RuleEditor key={editor.file} spec={editor} />;
}
