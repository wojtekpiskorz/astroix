import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { chromeHtml } from './chrome-html';
import { isDocumentRequest } from './document-request';
import { registerRestEndpoints } from './rest';
import { chromeArtifactPath, clientEntryPath } from './source-mode';
import { registerFileSync } from './watch-sync';

export const VIRTUAL_CHROME_ID = 'virtual:astroix/chrome';

export interface AstroixPluginOptions {
  /** Absolute Astro src dir with the sources to index; defaults to `<root>/src`. */
  srcDir?: string;
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
export function astroixVitePlugin(options: AstroixPluginOptions = {}): Plugin {
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
      registerRestEndpoints(server, {
        root: server.config.root,
        srcDir: options.srcDir ?? join(server.config.root, 'src'),
      });
      registerFileSync(server, {
        root: server.config.root,
        srcDir: options.srcDir ?? join(server.config.root, 'src'),
      });
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
        // so the host dev server transforms it (fast-refresh, Tailwind).
        return `import { mountChrome } from '/@fs${clientEntryPath}';\nmountChrome();\n`;
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
