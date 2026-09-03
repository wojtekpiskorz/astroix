import { createAppClient } from '@wojciechpiskorz/astroix-app-shell/app-client';
import { AppShell, ShellProvider } from '@wojciechpiskorz/astroix-app-shell/shell';
import { createRoot } from 'react-dom/client';
import { readBootstrap } from '../client/page-kit.ts';

/**
 * The web host's app-shell entry (#241, G2): the project document's
 * module — the rebuilt app shell (React) over the ONE AppClient at the
 * document's exact `SessionRef`. The document surface bound the pair
 * and the editor capability at serve time (#240's documents.ts); this
 * entry adopts the pair, mounts the shell provider (role:
 * authoritative — the web project document binds the editor
 * capability), and renders the shell frame with its empty feature
 * slots. Deactivation runs the one ordered reset — state removal
 * BEFORE the top-level replacement — inside the shell.
 */

const bootstrap = readBootstrap();
if (bootstrap.session === undefined) throw new Error('the project document carries no session');

const client = createAppClient({ clientCapability: bootstrap.clientCapability });

const mount = document.getElementById('astroix-app');
if (mount === null) throw new Error('the project document carries no app mount');

createRoot(mount).render(
  // biome-ignore lint/a11y/useValidAriaRole: ShellProvider's `role` prop is the #241 session role (authoritative | diagnostic), not an ARIA attribute
  <ShellProvider client={client} sessionRef={bootstrap.session} role="authoritative">
    <AppShell />
  </ShellProvider>,
);
