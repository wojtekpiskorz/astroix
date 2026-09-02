import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
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
});
