import { ProjectCanvas } from '@wojciechpiskorz/astroix-app-shell/shell';
import type { ReactNode } from 'react';

/**
 * The web host's canvas-route composition (#242, G3): what fills the
 * shell's canvas slot — the natural-route same-origin canvas. The
 * project document IS served on the active project hostname
 * (`http://<project-key>.localhost:<port>/__astroix/app/`, the document
 * surface), so its own origin is already the exact project origin the
 * canvas must share; the canvas loads the natural root (`/` — the
 * resolved base plus the root route for the default base this host
 * registers today) and every later URL is the project's own (observed,
 * never composed here). No synthetic canvas path and no builder query
 * exists anywhere in the composition; the resolved-base descriptor
 * joins through the project inspection when its adapter seam lands,
 * and until then the natural root is the honest initial route.
 */
export function CanvasRouteSlot(): ReactNode {
  return <ProjectCanvas initialRoute="/" />;
}
