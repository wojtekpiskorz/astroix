import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalProjectRoot } from './installed-pair';
import { certifyPairBeforeConfig } from './pair-gate';
import type { ViteRuntimeSeams, ViteServerLike } from './seam-readers';
import { readAstroCssUtil, readGetViteConfig, readViteRuntime } from './seam-readers';

/**
 * The composition surface (ADR-0005 "Real configuration and duplicate
 * hooks"): external composition via `astro/config#getViteConfig()` over
 * the managed project's REAL configuration, in middleware mode (no port,
 * no page serving — inspection only). Everything version-sensitive is
 * resolved from the managed project's own installation, and — the load
 * bearing order — the pair gate runs to completion BEFORE any Astro or
 * Vite module is imported: an uncertified pair fails before project
 * config can execute, `configFile: false` is never used, and the
 * project's integrations execute here exactly as they do in the managed
 * dev server (the accepted duplicate-hook cost, #202/#206).
 *
 * This module is the adapter's IO seam — the only file that imports
 * managed-project Astro/Vite — so its truth is the certification suite
 * over a real install of the certified pair, not unit fakes at the
 * behavior layer (coverage-tier decision, #225).
 */

/** Everything the adapter resolved from the managed project's installation, post-gate. */
export interface ProjectRuntimeSeams {
  /** The certified pair this runtime was gated against. */
  readonly certifiedPair: { readonly astro: string; readonly vite: string };
  /** The canonicalized (realpath'd) managed project root. */
  readonly projectRoot: string;
  readonly getViteConfig: ReturnType<typeof readGetViteConfig>;
  readonly vite: ViteRuntimeSeams;
  /** Astro's internal CSS utility — names a route component's dev-css virtual module. */
  readonly getDevCSSModuleName: (componentId: string) => string;
}

/** A booted composition server: middleware-mode Vite over the project's real config. */
export interface CompositionServer {
  readonly seams: ProjectRuntimeSeams;
  readonly server: ViteServerLike;
  /** Idempotent close of the composition server and its watcher. */
  close(): Promise<void>;
}

/**
 * Loads the managed project's Astro/Vite seams behind the pair gate: the
 * gate resolves and certifies the installed pair first; only a certified
 * pair reaches the `astro/config`, `vite`, and internal CSS-utility
 * imports (each resolved through the project's own installation).
 */
export async function loadProjectRuntimeSeams(projectRoot: string): Promise<ProjectRuntimeSeams> {
  const root = await canonicalProjectRoot(projectRoot);
  return certifyPairBeforeConfig({ projectRoot: root }, async (certifiedPair) => {
    const projectRequire = createRequire(join(root, 'package.json'));

    const astroConfig = await importModule(projectRequire.resolve('astro/config'));
    const vite = await importModule(projectRequire.resolve('vite'));
    const cssUtilPath = join(
      dirname(projectRequire.resolve('astro/package.json')),
      'dist',
      'vite-plugin-css',
      'util.js',
    );
    const cssUtil = await importModule(cssUtilPath);

    return {
      certifiedPair,
      projectRoot: root,
      getViteConfig: readGetViteConfig(astroConfig),
      vite: readViteRuntime(vite),
      getDevCSSModuleName: readAstroCssUtil(cssUtil),
    };
  });
}

/**
 * Boots the composition inspector over the project's real Astro
 * configuration: `getViteConfig` with middleware-mode server settings,
 * then Vite `createServer`. The project's config (and its integrations)
 * execute inside the factory call — the duplicate execution the charter
 * accepts and the certification observes.
 */
export async function createCompositionServer(projectRoot: string): Promise<CompositionServer> {
  const seams = await loadProjectRuntimeSeams(projectRoot);
  const root = seams.projectRoot;
  const configFactory = seams.getViteConfig(
    { clearScreen: false, logLevel: 'silent', root, server: { middlewareMode: true } },
    { root },
  );
  const viteConfig = await configFactory({ command: 'serve', mode: 'development' });
  const server = await seams.vite.createServer(viteConfig);
  let closed = false;
  return {
    seams,
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
    },
  };
}

async function importModule(id: string): Promise<unknown> {
  return import(pathToFileURL(id).href);
}
