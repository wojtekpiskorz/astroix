import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Canvas } from './canvas/canvas';
import { ContentEditorPane } from './features/content/editor-pane';
import { INDEX_PAYLOAD_KEY } from './features/css/api';
import { ChromeHeader } from './features/css/chrome-header';
import { EditorPane } from './features/css/editor-pane';
import { Sidebar } from './sidebar';
import { useChromeStore } from './store';

export function App() {
  // file→chrome sync (spec #13): any pushed source change makes the payload
  // stale (ranges/lines moved) — refetch on every event, editor or not
  const queryClient = useQueryClient();
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const handler = (): void => {
      void queryClient.invalidateQueries({ queryKey: INDEX_PAYLOAD_KEY });
    };
    hot.on('astroix:file-changed', handler);
    return () => hot.off('astroix:file-changed', handler);
  }, [queryClient]);

  // The editor dock slot is app-shell; the pane inside it is feature-owned
  // and chosen by the active tab (ADR-0002 Consequences).
  const activeVertical = useChromeStore((state) => state.activeVertical);

  return (
    // `dark`: the shadcn theme block (.dark in chrome.css) — the foundation
    // components style themselves from these tokens (issue #44)
    <div className="dark flex h-full w-full flex-col bg-slate-950 text-slate-100">
      <ChromeHeader />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {activeVertical === 'css' ? <EditorPane /> : <ContentEditorPane />}
        <Canvas />
      </div>
    </div>
  );
}
