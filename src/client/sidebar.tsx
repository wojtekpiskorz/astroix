import { Tabs, TabsContent, TabsList, TabsTrigger } from '#components/ui/tabs.tsx';
import { ContentSidebar } from './features/content/sidebar';
import { CssSidebar } from './features/css/css-sidebar';
import { useChromeStore } from './store';

/**
 * The sidebar shell: the vertical tabs plus the active vertical's body.
 * Tab composition is app-shell (ADR-0002); the bodies are feature-owned.
 * The editor dock outside the sidebar swaps on the same `activeVertical`.
 */
export function Sidebar() {
  const activeVertical = useChromeStore((state) => state.activeVertical);
  const setActiveVertical = useChromeStore((state) => state.setActiveVertical);

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 border-r border-slate-800 p-4 text-sm">
      <Tabs
        className="min-h-0 flex-1"
        value={activeVertical}
        onValueChange={(value: unknown) => {
          if (value === 'css' || value === 'content') setActiveVertical(value);
        }}
      >
        <TabsList className="w-full">
          <TabsTrigger value="css">CSS</TabsTrigger>
          <TabsTrigger value="content">Content</TabsTrigger>
        </TabsList>
        <TabsContent className="flex min-h-0 flex-col" value="css">
          <CssSidebar />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-col" value="content">
          <ContentSidebar />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
