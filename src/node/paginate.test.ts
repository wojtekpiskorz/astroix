import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IntegrationResolvedRoute } from 'astro';
import { describe, expect, it } from 'vitest';
import { generatePaginateFunction } from './paginate';

// The pin: the vendored shim must behave exactly like astro core's own
// `generatePaginateFunction` (`dist/core/render/paginate.js`). Core does not
// export it through the `astro/runtime/*` wildcard, so the test imports the
// dist file directly by URL — a file-URL import bypasses the package exports
// map by design (that resolution is bare-specifier-only), reaching the very
// code the dev server runs. If the vendored copy and core ever drift, this
// fails. Skipped only where astro's dist tree is genuinely absent — never in
// CI, where the check job installs devDeps. (Paths anchor on `process.cwd()`
// — the vitest root — because import.meta.url is not a file URL under the
// happy-dom environment.)
const corePaginatePath = join(process.cwd(), 'node_modules/astro/dist/core/render/paginate.js');
const coreGeneratorPath = join(process.cwd(), 'node_modules/astro/dist/core/routing/generator.js');
const CORE_PAGINATE_URL = pathToFileURL(corePaginatePath).href;
const CORE_GENERATOR_URL = pathToFileURL(coreGeneratorPath).href;
const coreAvailable = existsSync(corePaginatePath);

/** Core's factory as this test calls it — the return value is the paginate utility. */
type CoreFactory = (
  route: unknown,
  base: string,
  trailingSlash: string,
) => (data: readonly unknown[], args?: unknown) => unknown;

const data = [...Array(25).keys()].map((n) => ({ id: n }));

/**
 * The fixture route both sides run against: core reads `.params` +
 * `.segments` (it builds its own generator); the shim reads `.generate`
 * (the hook route's closure, itself core's `getRouteGenerator`). Giving the
 * object both spellings keeps the comparison honest — same route, same
 * inputs, both implementations.
 */
async function paginationRoute(
  params: string[],
  segments: unknown[][],
): Promise<{
  route: IntegrationResolvedRoute;
  core: CoreFactory;
}> {
  const [{ generatePaginateFunction: core }, { getRouteGenerator }] = await Promise.all([
    import(CORE_PAGINATE_URL) as Promise<{ generatePaginateFunction: CoreFactory }>,
    import(CORE_GENERATOR_URL) as Promise<{
      getRouteGenerator: (
        segments: unknown[][],
        trailingSlash: string,
      ) => (params: unknown) => string;
    }>,
  ]);
  const route = {
    params,
    segments,
    generate: getRouteGenerator(segments, 'ignore'),
  } as unknown as IntegrationResolvedRoute;
  return { route, core };
}

const restSegments = [
  [{ content: 'blog', dynamic: false, spread: false }],
  [{ content: '...page', dynamic: true, spread: true }],
];
const paramSegments = [
  [{ content: 'blog', dynamic: false, spread: false }],
  [{ content: 'page', dynamic: true, spread: false }],
];

describe('generatePaginateFunction — vendored shim pinned to core (astro@7.2.7)', () => {
  it.skipIf(!coreAvailable)(
    'rest-param routes ([...page]) paginate identically — first page undefined, URLs chained',
    async () => {
      const { route, core } = await paginationRoute(['...page'], restSegments);
      expect(generatePaginateFunction(route)(data, { pageSize: 10 })).toEqual(
        core(route, '/', 'ignore')(data, { pageSize: 10 }),
      );
    },
  );

  it.skipIf(!coreAvailable)(
    'segment-param routes ([page]) paginate identically — first page numbered',
    async () => {
      const { route, core } = await paginationRoute(['page'], paramSegments);
      expect(generatePaginateFunction(route)(data)).toEqual(core(route, '/', 'ignore')(data));
    },
  );

  it.skipIf(!coreAvailable)(
    'additional params/props and a url formatter ride identically',
    async () => {
      const { route, core } = await paginationRoute(
        ['...page'],
        [[{ content: '...page', dynamic: true, spread: true }]],
      );
      const args = {
        pageSize: 7,
        params: { tag: 'arts' },
        props: { section: 'news' },
        format: (url: string) => `https://example.com${url}`,
      };
      expect(generatePaginateFunction(route)(data, args)).toEqual(
        core(route, '/', 'ignore')(data, args),
      );
    },
  );

  it.skipIf(!coreAvailable)('empty data still yields one page, identically', async () => {
    const { route, core } = await paginationRoute(
      ['...page'],
      [[{ content: '...page', dynamic: true, spread: true }]],
    );
    expect(generatePaginateFunction(route)([])).toEqual(core(route, '/', 'ignore')([]));
  });

  it.skipIf(!coreAvailable)('a route without a page param throws on both sides', async () => {
    const { route, core } = await paginationRoute(
      [],
      [[{ content: 'blog', dynamic: false, spread: false }]],
    );
    expect(() => generatePaginateFunction(route)(data)).toThrow();
    expect(() => core(route, '/', 'ignore')(data)).toThrow();
  });

  it.skipIf(!coreAvailable)(
    'the hook-shape invocation the enumeration actually makes — page params for `renders`',
    async () => {
      const { route } = await paginationRoute(['...page'], restSegments);
      const pages = generatePaginateFunction(route)(data, { pageSize: 10 }) as Array<{
        params: { page?: string };
      }>;
      expect(pages.map((page) => page.params.page)).toEqual([undefined, '2', '3']);
    },
  );
});
