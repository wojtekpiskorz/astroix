import { dirname } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { AstroIntegration } from 'astro';
import type { Plugin as VitePlugin } from 'vite';
import { clientEntryPath, isSourceMode } from './source-mode';
import { hostRegistersTailwind } from './tailwind-guard';
import { astroixVitePlugin } from './vite-plugin';

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
  return {
    name: 'astroix',
    hooks: {
      'astro:config:setup': ({ config, command, updateConfig, injectScript, logger }) => {
        if (command !== 'dev') return;

        const plugins: VitePlugin[] = [astroixVitePlugin()];

        if (isSourceMode()) {
          // ADR-0001 source mode: chrome from this checkout's source, with
          // fast-refresh scoped to chrome files only (host code untouched).
          const clientDir = dirname(clientEntryPath ?? '');
          plugins.push(...react({ include: new RegExp(`^${escapeRegExp(clientDir)}/.*\\.tsx?$`) }));
          if (hostRegistersTailwind(config.vite)) {
            logger.info('host already registers @tailwindcss/vite — reusing it for the chrome');
          } else {
            plugins.push(...tailwindcss());
          }
        }

        updateConfig({ vite: { plugins } });
        injectScript('page', CANVAS_SCRIPT);
      },
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default astroix;
