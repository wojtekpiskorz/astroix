import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import type { ProjectRuntimeSeams } from '../../astro-project-adapter/composition';
import type { ViteServerLike } from '../../astro-project-adapter/seam-readers';
import { createRouteStylesJoin } from '../../astro-project-adapter/styles/join/route-styles';

/**
 * The route styles join composition (#226 focused tests): one pass joins
 * the real fixture's static index with compiler-derived selectors
 * through injected stand-ins for the runner and client environments —
 * proving the revisioned, plain-data result (no Vite handles, no
 * compiler implementation objects), the monotonic revision that only a
 * successful join advances, and the fail-closed paths (the missing
 * active-route dev-css module). Real Astro/Vite behavior behind the
 * seams is the certification suite's truth (#225); these stand-ins
 * exercise the composition's own wiring only.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE_ROOT = join(REPO_ROOT, 'e2e', 'fixture');
const ROUTE_COMPONENT = 'src/pages/index.astro';
const DEV_CSS_MODULE = `virtual:astro:dev-css:${ROUTE_COMPONENT}`;

const SEAM_DEV_CSS_IMPORT = 'virtual:astro:dev-css module import for the active route component';
const SEAM_SOURCE_WALK =
  'styles join source-walk correspondence (compiled scoped modules ↔ walked static sources)';

interface FakeComposition {
  readonly server: ViteServerLike;
  readonly seams: ProjectRuntimeSeams;
  readonly runner: {
    import: (id: string) => Promise<unknown>;
    close: () => Promise<void>;
    isClosed: () => boolean;
  };
  readonly client: ClientStandIn;
}

interface ClientStandIn {
  /** Flip to true to make the next pass fail its page prime (a broken pass). */
  pagePrimeBroken: boolean;
  readonly transformRequests: string[];
  transformRequest(url: string): Promise<{ code: string } | null>;
  readonly moduleGraph: {
    getModuleById(id: string): unknown;
    getModuleByUrl(url: string): Promise<unknown>;
  };
  readonly pluginContainer: { resolveId(url: string): Promise<unknown> };
}

/**
 * Builds the composition stand-ins: an SSR environment with the hot
 * transport accounting the fresh-runner discipline reads, a runner that
 * exports one dev-css `css` set, and a client environment that primes
 * the page and transforms the scoped style module with the frozen
 * attribute-form selector.
 */
async function fakeComposition(options: { readonly devCssImport?: () => Promise<unknown> } = {}) {
  const corpus = JSON.parse(
    await readFile(
      join(REPO_ROOT, 'e2e', 'behavior-contracts', 'inspection', 'css-index.attribute.json'),
      'utf8',
    ),
  ) as {
    records: Array<{ scoped: boolean; effectiveSelector: string | null }>;
  };
  const scoped = corpus.records.find((record) => record.scoped);
  if (scoped?.effectiveSelector === null || scoped?.effectiveSelector === undefined) {
    throw new Error('the corpus carries no joined scoped record to synthesize');
  }
  const compiledCss = `${scoped.effectiveSelector} { color: #1e293b; }`;
  const styleCode = `const __vite__css = ${JSON.stringify(compiledCss)}`;
  const styleUrl = `/${ROUTE_COMPONENT}?astro&type=style&index=0&lang.css`;
  const resolvedId = `/abs/proj/${ROUTE_COMPONENT}?astro&type=style&index=0&lang.css`;
  const node = { transformResult: { code: styleCode } };
  const importDevCss =
    options.devCssImport === undefined
      ? async () => ({
          css: new Set([
            {
              id: `/abs/proj/${ROUTE_COMPONENT}?astro&type=style&index=0&lang.css`,
              url: styleUrl,
              content: 'never read',
            },
          ]),
        })
      : options.devCssImport;
  const emitter = new EventEmitter();
  const runner = {
    import: (id: string) =>
      id === DEV_CSS_MODULE ? importDevCss() : Promise.reject(new Error(`unexpected import ${id}`)),
    close: async () => {},
    isClosed: () => true,
  };
  const client: ClientStandIn = {
    pagePrimeBroken: false,
    transformRequests: [],
    transformRequest: async (url: string) => {
      client.transformRequests.push(url);
      if (url === `/${ROUTE_COMPONENT}` && !client.pagePrimeBroken) {
        return { code: 'export default {}' };
      }
      if (url === styleUrl) return { code: styleCode };
      return null;
    },
    moduleGraph: {
      getModuleById: (id: string) => (id === resolvedId ? node : undefined),
      getModuleByUrl: async (url: string) => (url === styleUrl ? node : null),
    },
    pluginContainer: { resolveId: async () => ({ id: resolvedId }) },
  };
  const server: ViteServerLike = {
    environments: {
      ssr: {
        moduleGraph: { getModuleById: () => null, getModuleByUrl: () => null },
        pluginContainer: { resolveId: async () => null },
        hot: { api: { outsideEmitter: emitter } },
      },
      client,
    },
    watcher: { on: () => ({}) },
    close: async () => {},
  };
  const seams: ProjectRuntimeSeams = {
    certifiedPair: { astro: '7.2.10', vite: '8.2.2' },
    projectRoot: FIXTURE_ROOT,
    getViteConfig: () => async () => ({}),
    vite: {
      createServer: async () => server,
      createServerModuleRunner: () => runner,
    },
    getDevCSSModuleName: (componentId: string) => `virtual:astro:dev-css:${componentId}`,
  };
  return { server, seams, runner, client } satisfies FakeComposition;
}

describe('createRouteStylesJoin (composition, over the real fixture sources)', () => {
  it('returns a revisioned, plain-data join of the fixture index with the compiler-derived selector', async () => {
    const fake = await fakeComposition();
    const joiner = createRouteStylesJoin({ server: fake.server, seams: fake.seams });
    const join = await joiner.join({ routeComponent: ROUTE_COMPONENT });

    expect(join.revision).toBe(1);
    // The full static index, in walk order, with the scoped record joined
    // from the compiler output and every global rule null.
    expect(join.records).toHaveLength(7);
    const scoped = join.records.filter((record) => record.scoped);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.effectiveSelector).toBe('.hero-title[data-astro-cid-lcdefpme]');
    expect(join.records.filter((record) => record.effectiveSelector === null)).toHaveLength(6);

    // Plain data only: no Vite handles, no compiler implementation
    // objects — structuredClone refuses functions, and the record shape
    // is exactly the served index-payload fields.
    expect(structuredClone(join)).toEqual(join);
    const recordKeys = new Set(Object.keys(join.records[0] ?? {}));
    expect(recordKeys).toEqual(
      new Set([
        'selector',
        'file',
        'range',
        'line',
        'media',
        'scoped',
        'styleBlockIndex',
        'effectiveSelector',
      ]),
    );

    // The pass ran as certified composition: page primed in the client
    // environment before the style transform, runner closed after.
    expect(fake.client.transformRequests[0]).toBe(`/${ROUTE_COMPONENT}`);
    expect(fake.runner.isClosed()).toBe(true);
  });

  it('advances the revision monotonically across successful joins', async () => {
    const fake = await fakeComposition();
    const joiner = createRouteStylesJoin({ server: fake.server, seams: fake.seams });
    const first = await joiner.join({ routeComponent: ROUTE_COMPONENT });
    const second = await joiner.join({ routeComponent: ROUTE_COMPONENT });
    expect(second.revision).toBe(first.revision + 1);
    expect(second.records).toEqual(first.records);
  });

  it('does not mint a revision for a failed pass', async () => {
    const fake = await fakeComposition();
    const joiner = createRouteStylesJoin({ server: fake.server, seams: fake.seams });
    const first = await joiner.join({ routeComponent: ROUTE_COMPONENT });
    expect(first.revision).toBe(1);
    // Break the page prime: the next pass fails, and the revision
    // counter must not advance for it.
    fake.client.pagePrimeBroken = true;
    await expect(joiner.join({ routeComponent: ROUTE_COMPONENT })).rejects.toMatchObject({
      code: 'seam-rejected',
    });
    fake.client.pagePrimeBroken = false;
    const third = await joiner.join({ routeComponent: ROUTE_COMPONENT });
    expect(third.revision).toBe(2);
  });

  it('fails closed when the active route dev-css module will not import', async () => {
    const fake = await fakeComposition({
      devCssImport: () => Promise.reject(new Error('module not found')),
    });
    const joiner = createRouteStylesJoin({ server: fake.server, seams: fake.seams });
    const rejection = await joiner.join({ routeComponent: ROUTE_COMPONENT }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    const error = rejection as AdapterError;
    expect(error.code).toBe('seam-rejected');
    expect(error.details).toMatchObject({
      seam: SEAM_DEV_CSS_IMPORT,
      seamClass: 'fail-closed private',
      expected: 'the active route component dev-css virtual module to import',
      observed: 'a module import rejection for the active route component',
    });
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('fails closed when the active route scoped block has no compiled module', async () => {
    // A dev-css set with no scoped-style entries: the active route's own
    // scoped block must find its compiled module — absence is a
    // rejection, never a null join.
    const fake = await fakeComposition({
      devCssImport: async () => ({
        css: new Set([
          { id: '/abs/proj/src/pages/home.css', url: '/src/pages/home.css', content: '' },
        ]),
      }),
    });
    const joiner = createRouteStylesJoin({ server: fake.server, seams: fake.seams });
    await expect(joiner.join({ routeComponent: ROUTE_COMPONENT })).rejects.toMatchObject({
      code: 'seam-rejected',
      details: {
        seam: 'styles join block correspondence (static scoped block ↔ compiled module)',
      },
    });
  });

  it('rejects the custom-srcDir world instead of minting a silent revision (#302)', async () => {
    // A staged custom-srcDir project (the stagedFixtureCopy idiom — the
    // canonical fixture is frozen): the route lives under lib/ with its
    // styles there, while src/ exists and holds a DIFFERENT styled page —
    // the quiet arm of the defect, where the src/-rooted walk used to
    // serve the src-only all-null payload and mint a revision silently.
    // The #302 cross-check rejects, naming the real condition.
    const world = await stageCustomSrcDirWorld();
    try {
      const joiner = createRouteStylesJoin({ server: world.server, seams: world.seams });
      const rejection = await joiner.join({ routeComponent: LIB_ROUTE.component }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(AdapterError);
      const error = rejection as AdapterError;
      expect(error.code).toBe('seam-rejected');
      expect(error.details).toMatchObject({
        seam: SEAM_SOURCE_WALK,
        seamClass: 'fail-closed private',
        expected: 'a static scoped block for at least one file the compiled scoped modules name',
        observed:
          'compiled scoped modules correlating with no static scoped block (the source walk and the compiler observed different source trees)',
      });

      // The failed pass minted nothing: the first successful join over
      // the same joiner — the healthy src-rooted route in the same world
      // — starts at revision 1, and its payload is exactly the walked
      // tree's records with the compiled selector joined.
      world.setDevCssImport(async () => ({
        css: new Set([{ id: SRC_MODULE_ID, url: SRC_STYLE_URL, content: 'never read' }]),
      }));
      const healthy = await joiner.join({ routeComponent: SRC_ROUTE.component });
      expect(healthy.revision).toBe(1);
      expect(healthy.records).toHaveLength(1);
      expect(healthy.records[0]).toMatchObject({
        selector: '.src-title',
        file: 'src/pages/index.astro',
        effectiveSelector: '.src-title[data-astro-cid-src]',
      });
    } finally {
      await world.dispose();
    }
  });
});

// ——— the staged custom-srcDir world (#302) ———

const LIB_ROUTE = {
  component: 'lib/pages/index.astro',
  contents: '<style>.lib-title { color: #1e293b; }</style>',
  compiledCss: '.lib-title[data-astro-cid-lib] { color: #1e293b; }',
};
const SRC_ROUTE = {
  component: 'src/pages/index.astro',
  contents: '<style>.src-title { color: red; }</style>',
  compiledCss: '.src-title[data-astro-cid-src] { color: red; }',
};
const SRC_MODULE_ID = `/abs/proj/${SRC_ROUTE.component}?astro&type=style&index=0&lang.css`;
const SRC_STYLE_URL = `/${SRC_ROUTE.component}?astro&type=style&index=0&lang.css`;

interface StagedCustomSrcDirWorld {
  readonly server: ViteServerLike;
  readonly seams: ProjectRuntimeSeams;
  /** Overrides the dev-css module set the next pass observes. */
  setDevCssImport(impl: () => Promise<unknown>): void;
  dispose(): Promise<void>;
}

/**
 * Stages a temp project whose route lives under a custom `lib/` srcDir
 * while `src/` also exists with its own styled page, plus composition
 * stand-ins (the file's fakeComposition idiom) that serve either
 * route's page and scoped style module — the initial dev-css set names
 * the lib module, the world the defect mints silently over.
 */
async function stageCustomSrcDirWorld(): Promise<StagedCustomSrcDirWorld> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'astroix-302-srcdir-'));
  for (const route of [LIB_ROUTE, SRC_ROUTE]) {
    await mkdir(join(projectRoot, route.component, '..'), { recursive: true });
    await writeFile(join(projectRoot, route.component), route.contents);
  }

  const routes = [LIB_ROUTE, SRC_ROUTE];
  const styleUrlOf = (route: (typeof routes)[number]) =>
    `/${route.component}?astro&type=style&index=0&lang.css`;
  const resolvedIdOf = (route: (typeof routes)[number]) =>
    `/abs/proj/${route.component}?astro&type=style&index=0&lang.css`;
  const styleCodeOf = (route: (typeof routes)[number]) =>
    `const __vite__css = ${JSON.stringify(route.compiledCss)}`;
  // One node object per route — the ownership proof reads the SAME node
  // under the resolved id and the url (identity, not shape).
  const nodes = new Map(
    routes.map((route) => [route, { transformResult: { code: styleCodeOf(route) } }]),
  );

  const devCssImportRef: { current: () => Promise<unknown> } = {
    current: async () => ({
      css: new Set([
        {
          id: `/abs/proj/${LIB_ROUTE.component}?astro&type=style&index=0&lang.css`,
          url: styleUrlOf(LIB_ROUTE),
          content: 'never read',
        },
      ]),
    }),
  };
  const emitter = new EventEmitter();
  const runner = {
    import: (id: string) =>
      id === `virtual:astro:dev-css:${LIB_ROUTE.component}` ||
      id === `virtual:astro:dev-css:${SRC_ROUTE.component}`
        ? devCssImportRef.current()
        : Promise.reject(new Error(`unexpected import ${id}`)),
    close: async () => {},
    isClosed: () => true,
  };
  const client = {
    transformRequest: async (url: string): Promise<{ code: string } | null> => {
      if (routes.some((route) => url === `/${route.component}`)) {
        return { code: 'export default {}' };
      }
      const styled = routes.find((route) => url === styleUrlOf(route));
      return styled === undefined ? null : { code: styleCodeOf(styled) };
    },
    moduleGraph: {
      getModuleById: (id: string): unknown => {
        const owner = routes.find((route) => resolvedIdOf(route) === id);
        return owner === undefined ? undefined : nodes.get(owner);
      },
      getModuleByUrl: async (url: string): Promise<unknown> => {
        const owner = routes.find((route) => styleUrlOf(route) === url);
        return owner === undefined ? null : nodes.get(owner);
      },
    },
    pluginContainer: {
      resolveId: async (url: string): Promise<{ id: string } | null> => {
        const owner = routes.find((route) => styleUrlOf(route) === url);
        return owner === undefined ? null : { id: resolvedIdOf(owner) };
      },
    },
  };
  const server: ViteServerLike = {
    environments: {
      ssr: {
        moduleGraph: { getModuleById: () => null, getModuleByUrl: () => null },
        pluginContainer: { resolveId: async () => null },
        hot: { api: { outsideEmitter: emitter } },
      },
      client,
    },
    watcher: { on: () => ({}) },
    close: async () => {},
  };
  const seams: ProjectRuntimeSeams = {
    certifiedPair: { astro: '7.2.10', vite: '8.2.2' },
    projectRoot,
    getViteConfig: () => async () => ({}),
    vite: {
      createServer: async () => server,
      createServerModuleRunner: () => runner,
    },
    getDevCSSModuleName: (componentId: string) => `virtual:astro:dev-css:${componentId}`,
  };
  return {
    server,
    seams,
    setDevCssImport: (impl: () => Promise<unknown>) => {
      devCssImportRef.current = impl;
    },
    dispose: async () => {
      await rm(projectRoot, { recursive: true, force: true });
    },
  };
}
