import { createAppClient } from '@wojciechpiskorz/astroix-app-shell/app-client';
import {
  AppShell,
  ContentDiscovery,
  ShellProvider,
} from '@wojciechpiskorz/astroix-app-shell/shell';
import { createRoot } from 'react-dom/client';
import { readBootstrap } from '../client/page-kit.ts';
import { CanvasRouteSlot } from './canvas-route.tsx';

/**
 * The web host's app-shell entry (#241, G2): the project document's
 * module — the rebuilt app shell (React) over the ONE AppClient at the
 * document's exact `SessionRef`. The document surface bound the pair
 * and the editor capability at serve time (#240's documents.ts); this
 * entry adopts the pair, mounts the shell provider (role:
 * authoritative — the web project document binds the editor
 * capability), and renders the shell frame — the canvas slot carries
 * the natural-route same-origin canvas (#242, G3's composition) and the
 * sidebar slot carries the Content vertical's discovery panel (J1,
 * #251 — its entry clicks navigate the canvas through the navigation
 * slice); the editor-dock slot stays a placeholder until its vertical.
 * Deactivation runs the one ordered reset — state removal BEFORE the
 * top-level replacement — inside the shell.
 */

const bootstrap = readBootstrap();
if (bootstrap.session === undefined) throw new Error('the project document carries no session');

const client = createAppClient({ clientCapability: bootstrap.clientCapability });

const mount = document.getElementById('astroix-app');
if (mount === null) throw new Error('the project document carries no app mount');

createRoot(mount).render(
  // biome-ignore lint/a11y/useValidAriaRole: ShellProvider's `role` prop is the #241 session role (authoritative | diagnostic), not an ARIA attribute
  <ShellProvider client={client} sessionRef={bootstrap.session} role="authoritative">
    <AppShell slots={{ sidebar: <ContentDiscovery />, canvas: <CanvasRouteSlot /> }} />
  </ShellProvider>,
);
