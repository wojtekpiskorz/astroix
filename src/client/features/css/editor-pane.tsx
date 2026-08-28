import { RuleEditor } from './rule-editor';
import { useCssStore } from './store';

export function EditorPane() {
  const editor = useCssStore((state) => state.editor);
  if (editor === null) {
    return (
      <div
        data-astroix-editor="empty"
        className="flex min-h-0 flex-1 items-center justify-center text-xs text-slate-600"
      >
        Click a rule to edit its file.
      </div>
    );
  }
  return <RuleEditor key={editor.file} spec={editor} />;
}
