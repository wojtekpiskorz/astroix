import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Canvas } from './canvas/canvas';
import { ChromeHeader } from './features/css/chrome-header';
import { EditorPane } from './features/css/editor-pane';
import { Sidebar } from './features/css/sidebar';

export function App() {
  // file→chrome sync (spec #13): any pushed source change makes the payload
  // stale (ranges/lines moved) — refetch on every event, editor or not
  const queryClient = useQueryClient();
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const handler = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['astroix', 'index-payload'] });
    };
    hot.on('astroix:file-changed', handler);
    return () => hot.off('astroix:file-changed', handler);
  }, [queryClient]);

  return (
    // `dark`: the shadcn theme block (.dark in chrome.css) — the foundation
    // components style themselves from these tokens (issue #44)
    <div className="dark flex h-full w-full flex-col bg-slate-950 text-slate-100">
      <ChromeHeader />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <EditorPane />
        <Canvas />
      </div>
    </div>
  );
}
