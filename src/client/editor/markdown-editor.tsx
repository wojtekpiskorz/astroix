import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { createEditorView, replaceDoc } from './codemirror';
import { MarkdownToolbar } from './markdown-toolbar';

interface MarkdownEditorProps {
  /** The entry body as loaded (query data); null = data-only entry → empty doc. */
  body: string | null;
  /**
   * Emits the doc's markdown on every change — the seam the auto-write loop
   * (#74) wires into debounce → serialize → splice. Nothing here touches
   * disk; the doc is the source of truth while editing.
   */
  onChange: (markdown: string) => void;
}

/**
 * The entry body editor: CodeMirror 6 over `entry.body` with the markdown
 * toolbar. The baseline (RuleEditor's model) is the last externally-loaded
 * body: external `body` prop changes rebase the doc only while it is clean —
 * a dirty doc never gets clobbered; #74's write loop owns reconciling it.
 */
export function MarkdownEditor({ body, onChange }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const baselineRef = useRef<string>(body ?? '');
  const onChangeRef = useRef(onChange);

  // latest-callback ref, kept in an effect — render-time ref writes don't
  // survive React Compiler replay
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = createEditorView({
      doc: baselineRef.current,
      parent: host,
      extensions: [
        markdown(),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // mounts once; body flows through the external-sync effect below
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const incoming = body ?? '';
    if (incoming === view.state.doc.toString()) return; // echo of the same body
    if (view.state.doc.toString() !== baselineRef.current) return; // dirty
    replaceDoc(view, incoming);
    baselineRef.current = incoming;
  }, [body]);

  return (
    <div data-astroix-body-editor="view" className="flex min-h-0 flex-1 flex-col">
      <MarkdownToolbar view={() => viewRef.current} />
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
