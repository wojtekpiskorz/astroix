import {
  SidebarContent,
  SidebarHeader,
  SidebarRail,
  Sidebar as SidebarRoot,
} from '#components/ui/sidebar.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#components/ui/tabs.tsx';
import { ContentSidebar } from './features/content/content-sidebar';
import { CssSidebar } from './features/css/css-sidebar';
import { useChromeStore } from './store';

/**
 * The sidebar region on the shadcn Sidebar primitive (issue #81): the
 * vertical tabs pin in the sidebar header, the vertical bodies render in the
 * scrollable content area, and the rail (or cmd/ctrl+b) collapses the whole
 * region offcanvas. The primitive writes its state cookie; the shell reads
 * it back on boot (`defaultOpen` in app.tsx) — the state survives reloads.
 * Tab composition stays app-shell (ADR-0002); the editor dock outside the
 * sidebar swaps on the same `activeVertical`.
 */
export function Sidebar() {
  const activeVertical = useChromeStore((state) => state.activeVertical);
  const setActiveVertical = useChromeStore((state) => state.setActiveVertical);

  return (
    // `absolute` overrides the primitive's `fixed` container (its own merge
    // seam): with the provider `relative`, the sidebar spans the workbench
    // row below the chrome header instead of the whole viewport
    <SidebarRoot collapsible="offcanvas" className="absolute h-full">
      <Tabs
        className="flex min-h-0 flex-1 flex-col"
        value={activeVertical}
        onValueChange={(value: unknown) => {
          if (value === 'css' || value === 'content') setActiveVertical(value);
        }}
      >
        <SidebarHeader>
          <TabsList className="w-full">
            <TabsTrigger value="css">CSS</TabsTrigger>
            <TabsTrigger value="content">Content</TabsTrigger>
          </TabsList>
        </SidebarHeader>
        <SidebarContent>
          <TabsContent className="flex min-h-0 flex-col" value="css">
            <CssSidebar />
          </TabsContent>
          <TabsContent className="flex min-h-0 flex-col" value="content">
            <ContentSidebar />
          </TabsContent>
        </SidebarContent>
      </Tabs>
      <SidebarRail />
    </SidebarRoot>
  );
}
