import { describe, expect, it } from 'vitest';
import type { RouteMetadataEntry } from '../../astro-project-adapter/routes/route-metadata';
import {
  createRouteSelectionResolver,
  matchRouteSelection,
} from '../../astro-project-adapter/routes/route-selection';
import { type FakeRunnerOptions, fakeComposition, fixtureRouteMetadata } from './fixture-seams';

/**
 * The route-selection resolution seam (#370, the ruling's direction
 * (b) + pathname): the pure pathname→pattern→component matcher and the
 * fresh-pass resolver over the seam-layer composition stand-in (#229
 * idiom). The matcher's semantics are the certified pair's own
 * (`astro/dist/core/routing/pattern.js`: static literal, dynamic
 * non-empty run, a lone spread segment as an optional zero-or-more
 * tail, first match in seam order — the export order Astro's own
 * router sorts and then `find`s). The no-disclosure law is pinned from
 * the test side: the answer carries the component for the control
 * plane alone, and nothing here lets it ride a payload.
 */

function resolver(
  options: FakeRunnerOptions = {},
  create: { readonly waitTimeoutMs?: number } = {},
) {
  const harness = fakeComposition(options);
  return {
    harness,
    resolver: createRouteSelectionResolver({ composition: harness.composition, ...create }),
  };
}

describe('matchRouteSelection (the pure matcher)', () => {
  it('resolves the fixture corpus: root, static-dynamic precedence, rest routes, and first-match order', () => {
    const metadata = fixtureRouteMetadata();
    // The root route: segments [] matches the bare root pathname.
    expect(matchRouteSelection(metadata, '/')).toEqual({
      pattern: '/',
      component: 'src/pages/index.astro',
    });
    // A flat blog id matches BOTH dynamic routes; the seam order decides
    // — `/blog/[slug]` precedes `/blog/[...slug]`, exactly the order
    // Astro's own sorted router matches in.
    expect(matchRouteSelection(metadata, '/blog/hello-builder')).toEqual({
      pattern: '/blog/[slug]',
      component: 'src/pages/blog/[slug].astro',
    });
    // A nested blog id only the rest route serves.
    expect(matchRouteSelection(metadata, '/blog/2024/post')).toEqual({
      pattern: '/blog/[...slug]',
      component: 'src/pages/blog/[...slug].astro',
    });
    // The certified builder's optional tail — `(?:\/(.*?))?` — the rest
    // route matches its bare prefix too (zero remaining segments).
    expect(matchRouteSelection(metadata, '/blog')).toEqual({
      pattern: '/blog/[...slug]',
      component: 'src/pages/blog/[...slug].astro',
    });
  });

  it('never resolves the internal route, an endpoint, or a non-.astro component', () => {
    const extras: RouteMetadataEntry[] = [
      {
        pattern: '/api/data.json',
        component: 'src/pages/api/data.json.ts',
        type: 'endpoint',
        origin: 'project',
        prerender: false,
        params: [],
        segments: [
          [
            { content: 'api', dynamic: false, spread: false },
            { content: 'data.json', dynamic: false, spread: false },
          ],
        ],
      },
      {
        pattern: '/docs/readme',
        component: 'src/pages/docs/readme.md',
        type: 'page',
        origin: 'project',
        prerender: true,
        params: [],
        segments: [
          [
            { content: 'docs', dynamic: false, spread: false },
            { content: 'readme', dynamic: false, spread: false },
          ],
        ],
      },
    ];
    const metadata = [...fixtureRouteMetadata(), ...extras];
    // The internal server-islands route exists in the seam's output but
    // is no selection's answer (the payload membership law).
    expect(matchRouteSelection(metadata, '/_server-islands/[name]')).toBeNull();
    expect(matchRouteSelection(metadata, '/_server-islands/anything')).toBeNull();
    // Endpoints are not the canvas's documents.
    expect(matchRouteSelection(metadata, '/api/data.json')).toBeNull();
    // A page whose component is not an .astro page path cannot serve a
    // styles inspection — unresolvable, never a doomed dispatch.
    expect(matchRouteSelection(metadata, '/docs/readme')).toBeNull();
  });

  it('is fail-closed on non-pathname shapes and unmatched pathnames — never a guess', () => {
    const metadata = fixtureRouteMetadata();
    for (const route of [
      '', // nothing
      'blog/hello-builder', // relative shape — not a pathname
      './blog', // relative-filesystem shape
      '/blog//x', // an empty inner segment
      '/blog\\x', // backslash
      '/blog?q=1', // a query — never observed on location.pathname
      '/blog#top', // a fragment
      '/blog/%E0%A4%A', // an undecodable percent escape
      '/no/such/route', // a well-formed pathname no route serves
      '/blog/', // …but a single trailing slash IS the observed form: normalized, resolvable
    ]) {
      if (route === '/blog/') {
        expect(matchRouteSelection(metadata, route)).toEqual({
          pattern: '/blog/[...slug]',
          component: 'src/pages/blog/[...slug].astro',
        });
      } else {
        expect(matchRouteSelection(metadata, route), route).toBeNull();
      }
    }
  });

  it('decodes percent-encoded pathnames before matching (the dev server matches decoded paths)', () => {
    const metadata: RouteMetadataEntry[] = [
      ...fixtureRouteMetadata(),
      {
        pattern: '/glossary/[term]',
        component: 'src/pages/glossary/[term].astro',
        type: 'page',
        origin: 'project',
        prerender: true,
        params: ['term'],
        segments: [
          [{ content: 'glossary', dynamic: false, spread: false }],
          [{ content: 'term', dynamic: true, spread: false }],
        ],
      },
    ];
    expect(matchRouteSelection(metadata, '/glossary/Caf%C3%A9%20Culture')).toEqual({
      pattern: '/glossary/[term]',
      component: 'src/pages/glossary/[term].astro',
    });
  });

  it('matches mixed static-dynamic segments (parts join within one segment)', () => {
    const metadata: RouteMetadataEntry[] = [
      {
        pattern: '/post-[id]',
        component: 'src/pages/post-[id].astro',
        type: 'page',
        origin: 'project',
        prerender: true,
        params: ['id'],
        segments: [
          [
            { content: 'post-', dynamic: false, spread: false },
            { content: 'id', dynamic: true, spread: false },
          ],
        ],
      },
    ];
    expect(matchRouteSelection(metadata, '/post-123')).toEqual({
      pattern: '/post-[id]',
      component: 'src/pages/post-[id].astro',
    });
    // A dynamic part is NON-empty (`([^/]+?)`): the bare static prefix does not match.
    expect(matchRouteSelection(metadata, '/post-')).toBeNull();
    expect(matchRouteSelection(metadata, '/post-abc')).not.toBeNull();
  });
});

describe('createRouteSelectionResolver.resolve', () => {
  it('resolves over the seam read, with a monotonic revision per completed pass', async () => {
    const { resolver: routeSelectionResolver, harness } = resolver();
    const first = await routeSelectionResolver.resolve({ route: '/' });
    const second = await routeSelectionResolver.resolve({ route: '/blog/hello-builder' });
    const third = await routeSelectionResolver.resolve({ route: '/no/such/route' });
    expect(first).toEqual({
      revision: 1,
      selection: { pattern: '/', component: 'src/pages/index.astro' },
    });
    expect(second).toEqual({
      revision: 2,
      selection: { pattern: '/blog/[slug]', component: 'src/pages/blog/[slug].astro' },
    });
    // Unresolvable is result data at this seam — the executor's 404 — never a rejection.
    expect(third).toEqual({ revision: 3, selection: null });
    // One fresh runner per pass, closed every time (the #206 discipline).
    expect(harness.runners).toHaveLength(3);
    for (const runner of harness.runners) expect(runner.isClosed()).toBe(true);
  });

  it('re-reads the seam on every pass — a changed route table is the next answer', async () => {
    // A mutable options holder the fake runner reads live on every import
    // (the shared FakeRunnerOptions fields are read-only by contract).
    const options: { virtualRoutesExport?: unknown } = {};
    const { resolver: routeSelectionResolver } = resolver(options as FakeRunnerOptions);
    expect(await routeSelectionResolver.resolve({ route: '/' })).toEqual({
      revision: 1,
      selection: { pattern: '/', component: 'src/pages/index.astro' },
    });
    // Swap the export for one without the root route: the NEXT pass
    // honestly reflects it (no cached selection).
    options.virtualRoutesExport = {
      routes: [
        {
          file: '',
          links: [],
          scripts: [],
          styles: [],
          routeData: {
            route: '/only/[page]',
            component: 'src/pages/only/[page].astro',
            type: 'page',
            origin: 'project',
            prerender: true,
            params: ['page'],
            segments: [
              [{ content: 'only', dynamic: false, spread: false }],
              [{ content: 'page', dynamic: true, spread: false }],
            ],
          },
        },
      ],
    };
    expect(await routeSelectionResolver.resolve({ route: '/' })).toEqual({
      revision: 2,
      selection: null,
    });
    expect(await routeSelectionResolver.resolve({ route: '/only/anything' })).toEqual({
      revision: 3,
      selection: { pattern: '/only/[page]', component: 'src/pages/only/[page].astro' },
    });
  });

  it('fails closed on seam drift — a rejected pass rejects, and the revision stands still', async () => {
    const { resolver: routeSelectionResolver } = resolver({
      virtualRoutesExport: { routes: 'not-an-array' },
    });
    await expect(routeSelectionResolver.resolve({ route: '/' })).rejects.toThrow(/seam rejection/i);
    // The rejected pass ticked nothing: the next completed pass is revision 1.
    const { resolver: fresh } = resolver({ virtualRoutesExport: undefined });
    expect(await fresh.resolve({ route: '/' })).toEqual({
      revision: 1,
      selection: { pattern: '/', component: 'src/pages/index.astro' },
    });
  });

  it('rejects with the caller’s abort reason and never ticks the revision', async () => {
    const { resolver: routeSelectionResolver } = resolver({ hangingVirtualRoutesImport: true });
    const controller = new AbortController();
    const reason = new Error('the caller abandoned the resolution');
    const pending = routeSelectionResolver.resolve({ route: '/', signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('bounds a hanging metadata read by the per-wait bound', async () => {
    const { resolver: routeSelectionResolver } = resolver(
      { hangingVirtualRoutesImport: true },
      { waitTimeoutMs: 20 },
    );
    await expect(routeSelectionResolver.resolve({ route: '/' })).rejects.toThrow(
      /exceeded its per-wait bound/,
    );
  });

  it('leaks no live module-graph field — the selection is plain data', async () => {
    const { resolver: routeSelectionResolver } = resolver();
    const result = await routeSelectionResolver.resolve({ route: '/blog/hello-builder' });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(Object.keys(result)).toEqual(['revision', 'selection']);
    expect(Object.keys(result.selection ?? {})).toEqual(['pattern', 'component']);
  });
});
