import type { IntegrationResolvedRoute } from 'astro';
import { describe, expect, it, vi } from 'vitest';
import { extractRenders } from './route-enumeration';
import { applyRenders, captureRoutes, type RoutesState, toRouteInfos } from './routes';

function hookRoute(overrides: Record<string, unknown>): IntegrationResolvedRoute {
  return {
    pattern: '/blog/[...slug]',
    segments: [
      [{ content: 'blog', dynamic: false, spread: false }],
      [{ content: '...slug', dynamic: true, spread: true }],
    ],
    params: ['...slug'],
    type: 'page',
    isPrerendered: true,
    ...overrides,
  } as unknown as IntegrationResolvedRoute;
}

function state(): RoutesState {
  return { current: [], captured: [], projectionChanged: false };
}

describe('toRouteInfos', () => {
  it('projects page routes onto RouteInfo with Astro segments, deep-copied', () => {
    const segments = [[{ content: 'blog', dynamic: false, spread: false }]];
    const [info] = toRouteInfos([hookRoute({ segments })]);
    expect(info).toEqual({
      pattern: '/blog/[...slug]',
      segments,
      params: ['...slug'],
      rendering: 'prerendered',
    });
    expect(info?.segments).not.toBe(segments);
    expect(info?.segments[0]).not.toBe(segments[0]);
  });

  it('projects the hook isPrerendered as the rendering mode (#119)', () => {
    const infos = toRouteInfos([
      hookRoute({ pattern: '/ondemand/[slug]', isPrerendered: false }),
      hookRoute({ pattern: '/blog/[slug]', isPrerendered: true }),
    ]);
    expect(infos.map((info) => info.rendering)).toEqual(['on-demand', 'prerendered']);
    // `renders` is never projected here — the enumeration owns it
    expect(infos.every((info) => info.renders === undefined)).toBe(true);
  });

  it('drops endpoint, redirect and fallback routes (resolver contract, #77 ruling)', () => {
    const routes = [
      hookRoute({ type: 'page' }),
      hookRoute({ type: 'endpoint', pattern: '/api' }),
      hookRoute({ type: 'redirect', pattern: '/old' }),
      hookRoute({ type: 'fallback', pattern: '/404' }),
    ];
    expect(toRouteInfos(routes).map((info) => info.pattern)).toEqual(['/blog/[...slug]']);
  });

  it('drops Astro-core internal-origin routes — the dev server-islands route is not a page (#109)', () => {
    // astro core unshifts `/_server-islands/[name]` (origin 'internal') into
    // the manifest — a same-shape single-param candidate that would navigate
    // the canvas to a 404
    const routes = [
      hookRoute({ pattern: '/_server-islands/[name]', origin: 'internal' }),
      hookRoute({ pattern: '/blog/[slug]', origin: 'project' }),
      hookRoute({ pattern: '/injected/[slug]', origin: 'external' }),
    ];
    expect(toRouteInfos(routes).map((info) => info.pattern)).toEqual([
      '/blog/[slug]',
      '/injected/[slug]',
    ]);
  });
});

describe('captureRoutes — the hook writer (#119)', () => {
  it('flags the projection change on the first capture and fires onCapture', () => {
    const routesState = state();
    const onCapture = vi.fn();
    routesState.onCapture = onCapture;
    captureRoutes(routesState, [hookRoute({})]);
    expect(routesState.projectionChanged).toBe(true);
    expect(onCapture).toHaveBeenCalledOnce();
    expect(routesState.captured).toHaveLength(1);
  });

  it('a re-capture with unchanged routes keeps the payload byte-identical — no change flagged', () => {
    const routesState = state();
    captureRoutes(routesState, [hookRoute({})]);
    routesState.projectionChanged = false;
    captureRoutes(routesState, [hookRoute({})]);
    expect(routesState.projectionChanged).toBe(false);
  });

  it('preserves enumerated renders by pattern across a re-capture', () => {
    const routesState = state();
    captureRoutes(routesState, [hookRoute({})]);
    expect(applyRenders(routesState, new Map([['/blog/[...slug]', ['hello-builder']]]))).toBe(true);
    routesState.projectionChanged = false;
    // same routes re-captured (e.g. an unrelated srcDir watcher event) — the
    // enumerated truth survives; the payload is unchanged, so no push
    captureRoutes(routesState, [hookRoute({})]);
    expect(routesState.projectionChanged).toBe(false);
    expect(routesState.current[0]?.renders).toEqual(['hello-builder']);
  });

  it('a dropped pattern takes its renders with it — a changed projection flags', () => {
    const routesState = state();
    captureRoutes(routesState, [hookRoute({})]);
    applyRenders(routesState, new Map([['/blog/[...slug]', ['hello-builder']]]));
    captureRoutes(routesState, [hookRoute({ pattern: '/blog/[slug]', params: ['slug'] })]);
    expect(routesState.projectionChanged).toBe(true);
    expect(routesState.current[0]?.pattern).toBe('/blog/[slug]');
    expect(routesState.current[0]?.renders).toBeUndefined();
  });
});

describe('applyRenders — the enumeration merge (#119)', () => {
  it('sets renders where enumerated, keeps unknown absent, and reports the change', () => {
    const routesState = state();
    captureRoutes(routesState, [
      hookRoute({ pattern: '/blog/[slug]', params: ['slug'] }),
      hookRoute({}),
    ]);
    const changed = applyRenders(routesState, new Map([['/blog/[slug]', ['hello-builder']]]));
    expect(changed).toBe(true);
    expect(routesState.current.map((info) => [info.pattern, info.renders])).toEqual([
      ['/blog/[slug]', ['hello-builder']],
      ['/blog/[...slug]', undefined],
    ]);
    // an idempotent re-merge of the same truth changes nothing — no push
    expect(applyRenders(routesState, new Map([['/blog/[slug]', ['hello-builder']]]))).toBe(false);
  });

  it('an empty renders array is knowably-dead truth, not unknown', () => {
    const routesState = state();
    captureRoutes(routesState, [hookRoute({})]);
    applyRenders(routesState, new Map([['/blog/[...slug]', []]]));
    expect(routesState.current[0]?.renders).toEqual([]);
  });

  it('a route that leaves the enumeration (failed/timed out) degrades to unknown', () => {
    const routesState = state();
    captureRoutes(routesState, [hookRoute({})]);
    applyRenders(routesState, new Map([['/blog/[...slug]', ['hello-builder']]]));
    expect(applyRenders(routesState, new Map())).toBe(true);
    expect(routesState.current[0]?.renders).toBeUndefined();
  });
});

describe('extractRenders — getStaticPaths output → rendered param values (#119)', () => {
  it('collects the param values in first-occurrence order, deduplicated', () => {
    const staticPaths = [
      { params: { slug: 'hello-builder' } },
      { params: { slug: '2024/post' } },
      { params: { slug: 'hello-builder' } },
    ];
    expect(extractRenders(staticPaths, 'slug')).toEqual(['hello-builder', '2024/post']);
  });

  it('skips non-string values — paginate first pages carry undefined', () => {
    const pages = [
      { params: { page: undefined } },
      { params: { page: '2' } },
      { params: { page: '3' } },
    ];
    expect(extractRenders(pages, 'page')).toEqual(['2', '3']);
  });

  it('the rest-param key arrives without dots (…slug → slug)', () => {
    expect(extractRenders([{ params: { slug: 'nested/post' } }], 'slug')).toEqual(['nested/post']);
  });
});
