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
 * toolbar. Mounts once per entry (the pane keys it); external body changes
 * (query refetch) rebase the doc only while it is clean — a dirty doc is
 * #74's to reconcile through its write loop.
 */
export function MarkdownEditor({ body, onChange }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastEmittedRef = useRef<string>(body ?? '');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = createEditorView({
      doc: lastEmittedRef.current,
      parent: host,
      extensions: [
        markdown(),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          lastEmittedRef.current = text;
          onChangeRef.current(text);
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
    if (view.state.doc.toString() !== lastEmittedRef.current) return; // dirty
    replaceDoc(view, incoming);
    lastEmittedRef.current = incoming;
  }, [body]);

  return (
    <div data-astroix-body-editor="view" className="flex min-h-0 flex-1 flex-col">
      <MarkdownToolbar view={() => viewRef.current} />
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
