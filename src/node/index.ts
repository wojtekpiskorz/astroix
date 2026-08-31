import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { AstroIntegration } from 'astro';
import type { Plugin as VitePlugin } from 'vite';
import { captureRoutes, type RoutesState } from './routes';
import { clientEntryPath, isSourceMode } from './source-mode';
import { hostRegistersTailwind } from './tailwind-guard';
import { astroixVitePlugin, chromePayloadGuardPlugin } from './vite-plugin';

/**
 * Canvas script injected into every dev page (the chrome document itself is
 * never Astro-rendered, so this only ever runs inside host pages). It decides
 * on its own whether it is the builder canvas: inside the iframe
 * (`window.parent !== window`) with `?builder=0`, it hides Astro's dev
 * toolbar — the toolbar stays available on normal page loads (spec #2).
 */
const CANVAS_SCRIPT = `if (window.parent !== window && new URLSearchParams(location.search).get('builder') === '0') {
  const style = document.createElement('style');
  style.textContent = 'astro-dev-toolbar{display:none!important}';
  document.head.append(style);
}
`;

/**
 * Astroix — dev-only visual builder integration.
 *
 * In dev: the astroix Vite plugin serves the builder chrome over every
 * top-level URL (default-on) with the `?builder=0` escape hatch, and the
 * virtual chrome module delivers the app (source mode in this checkout per
 * ADR-0001; the prebuilt bundle lands with the chrome packaging slice).
 * Any other command registers nothing — the dev-only guarantee.
 */
function astroix(): AstroIntegration {
  // Routes captured from the hook below and served at `GET /__astroix/routes`
  // (spec Impl #13). Lives on the integration instance so both hooks —
  // the writer and the plugin that serves the state — share one container
  // across dev restarts (restarts re-run the routes hook on the same instance).
  // The background enumeration (`route-enumeration.ts`) fills `renders` into
  // it and watches the captures through `onCapture` (#119).
  const routesState: RoutesState = { current: [], captured: [] };
  return {
    name: 'astroix',
    hooks: {
      'astro:routes:resolved': ({ routes }) => {
        captureRoutes(routesState, routes);
      },
      'astro:config:setup': ({ config, command, updateConfig, injectScript, logger }) => {
        if (command !== 'dev') return;

        // The resolved config turns dir strings into URLs (trailing slash included) —
        // the plugin wants clean paths. The payload guard rides along as its
        // own post plugin (see vite-plugin.ts) so its transform runs last.
        const plugins: VitePlugin[] = [
          astroixVitePlugin({ srcDir: fileURLToPath(config.srcDir), routes: routesState }),
          chromePayloadGuardPlugin(),
        ];
        // The chrome sources live outside the host root and are served via
        // /@fs, which has two consequences fixed below: (a) deps discovered
        // from /@fs files resolve against the importer's location, so `react`
        // can enter the optimizer from two paths and mount twice (Invalid
        // hook call) — dedupe pins every resolution to the host root's React,
        // which in the dev checkout is our own 19; (b) HMR re-fetches carry a
        // `?t=` timestamp that misses the import-chain fs exemption — the
        // checkout root joins the allow list so chrome modules always serve.
        let vitePatch: {
          plugins: VitePlugin[];
          resolve?: { dedupe: string[] };
          server?: { fs: { allow: string[] } };
        } = { plugins };

        if (isSourceMode()) {
          // ADR-0001 source mode: chrome from this checkout's source, with
          // fast-refresh scoped to chrome files only (host code untouched).
          const clientDir = dirname(clientEntryPath ?? '');
          // compiler: true = React Compiler via oxc (stack #4: no manual memoization).
          plugins.push(
            ...react({
              include: new RegExp(`^${escapeRegExp(clientDir)}/.*\\.tsx?$`),
              compiler: true,
            }),
          );
          if (hostRegistersTailwind(config.vite)) {
            logger.info('host already registers @tailwindcss/vite — reusing it for the chrome');
          } else {
            plugins.push(...tailwindcss());
          }
          vitePatch = {
            plugins,
            resolve: { dedupe: ['react', 'react-dom'] },
            server: { fs: { allow: [dirname(dirname(clientDir))] } },
          };
        }

        updateConfig({ vite: vitePatch });
        injectScript('page', CANVAS_SCRIPT);
      },
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default astroix;
