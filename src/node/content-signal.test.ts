import type { IntegrationResolvedRoute } from 'astro';
import type { ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import {
  createContentSignalClassifier,
  createLoaderCommitClassifier,
  pushToChrome,
} from './content-signal';
import type { RoutesState } from './routes';

function entrypointRoute(entrypoint: string): IntegrationResolvedRoute {
  return { entrypoint } as unknown as IntegrationResolvedRoute;
}

/** The scope shape registerRouteEnumeration hands over (astro's srcDir keeps its trailing slash). */
function scope(routes: readonly IntegrationResolvedRoute[] = []): {
  root: string;
  srcDir: string;
  routes: RoutesState;
} {
  return { root: '/repo', srcDir: '/repo/src/', routes: { current: [], captured: routes } };
}

describe('createContentSignalClassifier', () => {
  it('classifies a srcDir file that is neither css nor a captured entrypoint', () => {
    const isContentSignal = createContentSignalClassifier(
      scope([entrypointRoute('src/pages/index.astro')]),
    );
    expect(isContentSignal('/repo/src/content/blog/hello.md')).toBe(true);
    expect(isContentSignal('/repo/src/content.config.ts')).toBe(true);
  });

  it('stays silent on css, captured entrypoints, and files outside srcDir', () => {
    const isContentSignal = createContentSignalClassifier(
      scope([entrypointRoute('src/pages/index.astro')]),
    );
    expect(isContentSignal('/repo/src/styles/global.css')).toBe(false);
    expect(isContentSignal('/repo/src/pages/index.astro')).toBe(false);
    expect(isContentSignal('/repo/astro.config.ts')).toBe(false);
    // the prefix check is segment-anchored — a sibling dir named src* is outside
    expect(isContentSignal('/repo/src-other/notes.md')).toBe(false);
  });

  it('follows the live capture — a recaptured entrypoint stops being a content signal', () => {
    const state = scope();
    const isContentSignal = createContentSignalClassifier(state);
    expect(isContentSignal('/repo/src/pages/new-route.astro')).toBe(true);
    state.routes.captured = [entrypointRoute('src/pages/new-route.astro')];
    expect(isContentSignal('/repo/src/pages/new-route.astro')).toBe(false);
  });
});

describe('createLoaderCommitClassifier', () => {
  it('classifies the dev data-store file and the chunked store dir', () => {
    const isLoaderCommit = createLoaderCommitClassifier('/repo');
    expect(isLoaderCommit('/repo/.astro/data-store.json')).toBe(true);
    expect(isLoaderCommit('/repo/.astro/data-store/manifest.json')).toBe(true);
  });

  it('stays silent on other dot-astro files and other roots', () => {
    const isLoaderCommit = createLoaderCommitClassifier('/repo/');
    expect(isLoaderCommit('/repo/.astro/assetImports.json')).toBe(false);
    expect(isLoaderCommit('/other/repo/.astro/data-store.json')).toBe(false);
    expect(isLoaderCommit('/repo/src/.astro/data-store.json')).toBe(false);
  });
});

describe('pushToChrome', () => {
  function serverWithClients(size: number): {
    server: ViteDevServer;
    send: ReturnType<typeof vi.fn>;
  } {
    const send = vi.fn();
    const clients = new Set<unknown>();
    for (let i = 0; i < size; i += 1) clients.add({});
    const server = { ws: { clients, send } } as unknown as ViteDevServer;
    return { server, send };
  }

  it('skips the send when no client is connected (the no-audience guard)', () => {
    const { server, send } = serverWithClients(0);
    pushToChrome(server, 'astroix:content-synced', 'loader');
    pushToChrome(server, 'astroix:routes-changed');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the content-synced push immediately, labeled with the leg that fired (#155)', () => {
    const { server, send } = serverWithClients(1);
    pushToChrome(server, 'astroix:content-synced', 'loader');
    pushToChrome(server, 'astroix:content-synced', 'srcdir');
    expect(send).toHaveBeenNthCalledWith(1, 'astroix:content-synced', { leg: 'loader' });
    expect(send).toHaveBeenNthCalledWith(2, 'astroix:content-synced', { leg: 'srcdir' });
  });

  it('sends the routes-changed push payload-less', () => {
    const { server, send } = serverWithClients(1);
    pushToChrome(server, 'astroix:routes-changed');
    expect(send).toHaveBeenCalledWith('astroix:routes-changed', {});
  });
});
