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

export const VIRTUAL_CHROME_ID = 'virtual:astroix/chrome';

export interface AstroixPluginOptions {
  /** Absolute Astro src dir with the sources to index; defaults to `<root>/src`. */
  srcDir?: string;
  /** Routes captured by the integration's `astro:routes:resolved` hook, served at `/__astroix/routes`. */
  routes: RoutesState;
}

/**
 * The chrome-payload guard (#171): vite's dev send inlines a module's
 * transform sourcemap as a base64 `sourceMappingURL` data URL whenever the
 * final map carries mappings. For the prebuilt chrome bundle that map is
 * dead weight — it maps the dev-transformed output back onto the shipped
 * bundle, not onto any source a developer can read — and it more than
 * triples the boot payload (measured on the fixture: 7.85 MB served vs
 * 2.2 MB of code, 72% inline map). The boot-stall family rides that window
 * client-side: a CPU-starved renderer holds the oversized response in
 * socket backpressure for as long as it is starved (frozen-renderer repro:
 * a 25 s stop made the module request take 25.7 s by the server-side
 * finish trace, 25.8 s browser-observed — the same event from both ends —
 * canvas visible at 26.2 s, next fresh page 1.8 s — the exact #158/#129
 * signature). The version-less `{ mappings: '' }` map is
 * vite's own "no map" sentinel: the sourcemap chain combiner short-circuits
 * on it, and dev `send` only appends a data URL when `map.mappings` is
 * truthy — do NOT add `version`, a versioned partial map is parsed as a
 * real one and crashes the combiner (caught live in the fixture lane). A
 * separate `enforce: 'post'` plugin so the transform runs after
 * import-analysis, whose freshly generated map would otherwise win.
 */
export function chromePayloadGuardPlugin(): Plugin {
  return {
    name: 'astroix:chrome-payload',
    enforce: 'post',
    transform(code, id) {
      if (id !== VIRTUAL_CHROME_ID) return null;
      return { code, map: { mappings: '' } };
    },
  };
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
        // the delivery mode it boots (#150).
        return `import { mountChrome } from '/@fs${clientEntryPath}';\nmountChrome('source');\n`;
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
      return readFileSync(chromeArtifactPath, 'utf8');
    },
  };
}
