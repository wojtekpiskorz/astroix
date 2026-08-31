import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { registerApiEndpoints } from './api';
import { chromeHtml } from './chrome-html';
import { registerChromeReloadShield } from './chrome-reload-shield';
import { contentHandlers } from './content';
import { isDocumentRequest } from './document-request';
import { restHandlers } from './rest';
import { registerRouteEnumeration } from './route-enumeration';
import { type RoutesState, routesHandlers } from './routes';
import { chromeArtifactPath, clientEntryPath } from './source-mode';
import { registerFileSync } from './watch-sync';

/**
 * The hot→window bridge (#166): `import.meta.hot` usage inside the chrome is
 * dead-code-eliminated by the lib build, so the chrome's push subscriptions
 * and its `astroix:chrome` announce ride window CustomEvents — those survive
 * bundling by construction. This translator is prepended to the virtual
 * chrome module in BOTH delivery arms (ADR-0001): served as module source,
 * its literal `import.meta.hot` is what makes Vite inject the hot context
 * into the module. It forwards the node-side push events (payload as
 * `detail`) to the window events the chrome subscribes to, and routes the
 * announce entry.tsx dispatches on `window` back onto the hot channel for
 * the reload shield. Prepend, never append: static imports are hoisted, so
 * the module body — bridge first — runs before `mountChrome()` (source arm)
 * and before the self-mounting bundle's top-level call (prebuilt arm); the
 * announce listener must exist by then. One code path, identical semantics
 * in both modes.
 */
const HOT_TO_WINDOW_BRIDGE = `// astroix hot→window bridge (#166): node pushes → window CustomEvents,
// the chrome's 'astroix:chrome' announce → hot.send (reload shield).
if (import.meta.hot) {
  const hot = import.meta.hot;
  const forward = (event) =>
    hot.on(event, (payload) => window.dispatchEvent(new CustomEvent(event, { detail: payload })));
  forward('astroix:file-changed');
  forward('astroix:content-synced');
  forward('astroix:routes-changed');
  forward('astro:content-changed');
  window.addEventListener('astroix:chrome', () => hot.send('astroix:chrome', {}));
}
`;

export const VIRTUAL_CHROME_ID = 'virtual:astroix/chrome';

export interface AstroixPluginOptions {
  /** Absolute Astro src dir with the sources to index; defaults to `<root>/src`. */
  srcDir?: string;
  /** Routes captured by the integration's `astro:routes:resolved` hook, served at `/__astroix/routes`. */
  routes: RoutesState;
}

/**
 * The astroix Vite plugin: default-on chrome over every top-level dev URL.
 * The middleware is registered in the body of `configureServer` (pre-internal)
 * because Astro's dev handler lives in a post-hook and never calls `next()` —
 * this is the only position that sees every request (core-reuse §1). The
 * chrome HTML passes through `server.transformIndexHtml` (the plugin hook
 * never fires for Astro pages, the server API does) which injects the Vite
 * client and the plugin-react preamble.
 */
export function astroixVitePlugin(options: AstroixPluginOptions): Plugin {
  return {
    name: 'astroix',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        void (async () => {
          try {
            const url = req.url ?? '/';
            if (
              !isDocumentRequest({ method: req.method ?? 'GET', url, accept: req.headers.accept })
            ) {
              next();
              return;
            }
            const html = await server.transformIndexHtml(url, chromeHtml());
            res.statusCode = 200;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(html);
          } catch (error) {
            next(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
      const srcDir = options.srcDir ?? join(server.config.root, 'src');
      registerApiEndpoints(server, {
        root: server.config.root,
        srcDir,
        routes: options.routes,
        handlers: [...restHandlers, ...contentHandlers, ...routesHandlers],
      });
      // the background getStaticPaths pass — fills `renders` into the routes
      // payload and pushes `astroix:routes-changed` when it lands (#119)
      registerRouteEnumeration(server, {
        root: server.config.root,
        srcDir,
        routes: options.routes,
      });
      registerFileSync(server, { root: server.config.root, srcDir });
      registerChromeReloadShield(server);
    },
    resolveId(id) {
      // The HTML references `/virtual:astroix/chrome`; imports may use the bare id.
      if (id === VIRTUAL_CHROME_ID || id === `/${VIRTUAL_CHROME_ID}`) {
        return VIRTUAL_CHROME_ID;
      }
      return null;
    },
    load(id) {
      if (id !== VIRTUAL_CHROME_ID) return null;
      if (clientEntryPath !== null) {
        // ADR-0001 source mode: the chrome loads from this checkout's source,
        // so the host dev server transforms it (fast-refresh, Tailwind). The
        // mode discriminator rides the mount call so each e2e lane can pin
        // the delivery mode it boots (#150). The bridge goes first — its
        // announce listener must exist before mountChrome() dispatches.
        return `${HOT_TO_WINDOW_BRIDGE}import { mountChrome } from '/@fs${clientEntryPath}';\nmountChrome('source');\n`;
      }
      // ADR-0001 prebuilt mode: serve the shipped bundle — a self-contained
      // ESM with react, the compiled CSS and CodeMirror inside, so foreign
      // hosts resolve none of our chrome dependencies. Missing artifact =
      // broken package build; fail loudly, never silently (ADR-0001).
      if (!existsSync(chromeArtifactPath)) {
        throw new Error(
          'astroix: prebuilt chrome bundle is missing from the package build (expected dist/chrome.js)',
        );
      }
      // The artifact self-mounts at the top level (chrome.tsx calls
      // mountChrome() in module scope) — the bridge precedes it so the
      // announce listener exists before the dispatch fires.
      return HOT_TO_WINDOW_BRIDGE + readFileSync(chromeArtifactPath, 'utf8');
    },
  };
}
