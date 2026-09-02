import { describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import type { DevCssSeamEntry } from '../../astro-project-adapter/seam-readers';
import { transformScopedStyleModules } from '../../astro-project-adapter/styles/join/client-scoped-css';

/**
 * The client-environment leg of the styles join (#226 focused tests):
 * page priming, scoped-module transforms, and — the load-bearing one —
 * client-environment MODULE-GRAPH OWNERSHIP: the graph must hold the
 * transformed module under both its resolved id and its url, with the
 * cached transform code. These units exercise the join's own rejection
 * paths with injected stand-ins; the real Vite behavior behind the seams
 * is the certification suite's truth (#225), never faked here as a
 * compatibility claim.
 */

const SEAM_PRIME = 'vite client environment page prime (transformRequest of the route page)';
const SEAM_TRANSFORM =
  'vite client environment scoped style transform (transformRequest of a dev-css module url)';
const SEAM_IDENTITY =
  'vite client environment scoped style module identity (plugin container resolveId)';
const SEAM_OWNERSHIP =
  'vite client environment module-graph ownership of the transformed scoped style module';

const ROUTE_COMPONENT = 'src/pages/index.astro';
const PAGE_URL = '/src/pages/index.astro';
const SCOPED_CSS = '.hero-title[data-astro-cid-proof] {\n  color: #1e293b;\n}';

function scopedEntry(blockIndex = 0): DevCssSeamEntry {
  return {
    id: `/proj/${ROUTE_COMPONENT}?astro&type=style&index=${blockIndex}&lang.css`,
    url: `/${ROUTE_COMPONENT}?astro&type=style&index=${blockIndex}&lang.css`,
    content: 'entry content is never read by the join',
  };
}

function plainCssEntry(): DevCssSeamEntry {
  return { id: '/proj/src/pages/home.css', url: '/src/pages/home.css', content: '.hero {}' };
}

interface GraphNode {
  readonly transformResult: { readonly code: string };
}

interface FakeClientOptions {
  readonly pageTransform?: { code: string } | null;
  readonly styleTransform?: { code: string } | null;
  readonly resolveIdReturns?: unknown;
  readonly urlNode?: GraphNode | null | 'distinct';
  readonly nodeCode?: string;
}

/**
 * A stand-in client environment shaped exactly like the certified one:
 * a page prime, style-module transforms whose code carries the Vite CSS
 * sentinel, a plugin container resolving every style url to one id, and
 * a module graph holding one node under that id.
 */
function fakeClient(options: FakeClientOptions = {}) {
  const styleCode = `const __vite__css = ${JSON.stringify(SCOPED_CSS)}`;
  const node: GraphNode = {
    transformResult: { code: options.nodeCode === undefined ? styleCode : options.nodeCode },
  };
  const distinctNode: GraphNode = { transformResult: { code: 'stale-by-url' } };
  const resolvedId = '/abs/proj/src/pages/index.astro?astro&type=style&index=0&lang.css';
  const isStyleUrl = (url: string) => url.includes('?astro&type=style&index=');
  const transformRequests: string[] = [];
  return {
    transformRequests,
    transformRequest: async (url: string): Promise<{ code: string } | null> => {
      transformRequests.push(url);
      if (url === PAGE_URL) {
        return options.pageTransform === undefined
          ? { code: 'export default {}' }
          : options.pageTransform;
      }
      if (isStyleUrl(url)) {
        return options.styleTransform === undefined ? { code: styleCode } : options.styleTransform;
      }
      return null;
    },
    moduleGraph: {
      getModuleById: (id: string): GraphNode | undefined => (id === resolvedId ? node : undefined),
      getModuleByUrl: async (url: string): Promise<GraphNode | null> => {
        if (!isStyleUrl(url)) return null;
        if (options.urlNode === 'distinct') return distinctNode;
        return options.urlNode === undefined ? node : options.urlNode;
      },
    },
    pluginContainer: {
      resolveId: async (): Promise<unknown> =>
        options.resolveIdReturns === undefined ? { id: resolvedId } : options.resolveIdReturns,
    },
  };
}

function transformOptions(): { readonly routeComponent: string } {
  return { routeComponent: ROUTE_COMPONENT };
}

async function expectJoinRejection(
  probe: () => Promise<unknown>,
  seam: string,
): Promise<AdapterError> {
  const rejection = await probe().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(AdapterError);
  const error = rejection as AdapterError;
  expect(error.code).toBe('seam-rejected');
  expect(error.details).toMatchObject({ seam, seamClass: 'fail-closed private' });
  return error;
}

describe('transformScopedStyleModules (happy path)', () => {
  it('primes the page, transforms scoped modules, and returns them in route order', async () => {
    const client = fakeClient();
    const modules = await transformScopedStyleModules(
      client,
      [plainCssEntry(), scopedEntry(0), scopedEntry(1)],
      transformOptions(),
    );
    // The page was primed first; the plain .css entry never transforms.
    expect(client.transformRequests[0]).toBe(PAGE_URL);
    expect(client.transformRequests).not.toContain('/src/pages/home.css');
    // Only the scoped-style entries produced modules, in entry order.
    expect(modules).toHaveLength(2);
    expect(modules[0]).toEqual({
      id: scopedEntry(0).id,
      url: scopedEntry(0).url,
      compiledCss: SCOPED_CSS,
    });
    expect(modules[1]?.id).toBe(scopedEntry(1).id);
  });

  it('never reads the dev-css entry content (route order, IDs, and URLs only)', async () => {
    const client = fakeClient();
    const contentless: DevCssSeamEntry = { ...scopedEntry(), content: '' };
    const modules = await transformScopedStyleModules(client, [contentless], transformOptions());
    expect(modules[0]?.compiledCss).toBe(SCOPED_CSS);
  });
});

describe('transformScopedStyleModules (fail-closed negatives)', () => {
  it('rejects when the client environment will not prime the route page', async () => {
    const error = await expectJoinRejection(
      () =>
        transformScopedStyleModules(
          fakeClient({ pageTransform: null }),
          [scopedEntry()],
          transformOptions(),
        ),
      SEAM_PRIME,
    );
    expect(error.details).toMatchObject({
      observed: 'a transformRequest result of null for the route page',
    });
  });

  it('rejects when a scoped style module will not transform', async () => {
    const error = await expectJoinRejection(
      () =>
        transformScopedStyleModules(
          fakeClient({ styleTransform: null }),
          [scopedEntry()],
          transformOptions(),
        ),
      SEAM_TRANSFORM,
    );
    expect(error.details).toMatchObject({
      observed: 'a transformRequest result of null for the scoped style module url',
    });
  });

  it('rejects when the plugin container resolves no string id', async () => {
    const error = await expectJoinRejection(
      () =>
        transformScopedStyleModules(
          fakeClient({ resolveIdReturns: null }),
          [scopedEntry()],
          transformOptions(),
        ),
      SEAM_IDENTITY,
    );
    expect(error.details).toMatchObject({
      observed: 'a resolution that carries no string id for the scoped style module url',
    });
  });

  it('rejects when the graph holds a different node under the url than under the resolved id', async () => {
    const error = await expectJoinRejection(
      () =>
        transformScopedStyleModules(
          fakeClient({ urlNode: 'distinct' }),
          [scopedEntry()],
          transformOptions(),
        ),
      SEAM_OWNERSHIP,
    );
    expect(error.details).toMatchObject({
      observed: expect.stringContaining('disagrees with the transform'),
    });
  });

  it('rejects when the graph node holds stale code (same node, cached code drifted)', async () => {
    await expectJoinRejection(
      () =>
        transformScopedStyleModules(
          fakeClient({ nodeCode: 'const stale = 1' }),
          [scopedEntry()],
          transformOptions(),
        ),
      SEAM_OWNERSHIP,
    );
  });

  it('propagates the environment shape probe when the client environment drifted', async () => {
    await expectJoinRejection(
      () =>
        transformScopedStyleModules(
          { transformRequest: async () => null },
          [scopedEntry()],
          transformOptions(),
        ),
      'vite client environment (transformRequest, module graph, plugin container)',
    );
  });
});
