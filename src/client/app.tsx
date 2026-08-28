import { useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useEffect } from 'react';
import { SidebarProvider } from '#components/ui/sidebar.tsx';
import { Canvas } from './canvas/canvas';
import { ContentEditorPane } from './features/content/content-editor-pane';
import { INDEX_PAYLOAD_KEY } from './features/css/api';
import { ChromeHeader } from './features/css/chrome-header';
import { EditorPane } from './features/css/editor-pane';
import { Sidebar } from './sidebar';
import { useChromeStore } from './store';

/**
 * Seeds the sidebar's open state from the primitive's persisted cookie —
 * the generated provider only writes it; the shell is its reader, through
 * the provider's own `defaultOpen` seam (client-only chrome, no SSR).
 * The cookie name is the primitive's SIDEBAR_COOKIE_NAME; the literal here
 * is deliberate (exporting the const would hand-edit the generated tier) —
 * the reload leg in tabs.spec.ts fails if a regeneration ever renames it.
 */
function initialSidebarOpen(): boolean {
  const match = document.cookie.match(/(?:^|;\s*)sidebar_state=(true|false)\b/);
  return match === null ? true : match[1] === 'true';
}

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
    <div className="dark flex h-full w-full flex-col bg-background text-foreground">
      <ChromeHeader />
      {/* The provider row `relative` + the sidebar's `absolute` keep the
          primitive's positioning inside the workbench row (below the header). */}
      <SidebarProvider
        className="relative min-h-0 flex-1"
        defaultOpen={initialSidebarOpen()}
        style={{ '--sidebar-width': '18rem' } as CSSProperties}
      >
        <Sidebar />
        {/* The dock's column frame — uniform width, border, background — is the
            slot's, not the pane's (owner ruling on the tabs PR); panes render
            frameless and choose only their inner layout. */}
        <div className="flex w-[480px] shrink-0 flex-col border-r border-border bg-background">
          {activeVertical === 'css' ? <EditorPane /> : <ContentEditorPane />}
        </div>
        <Canvas />
      </SidebarProvider>
    </div>
  );
}
