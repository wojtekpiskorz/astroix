import type { IntegrationResolvedRoute } from 'astro';
import { describe, expect, it } from 'vitest';
import { toRouteInfos } from './routes';

function hookRoute(overrides: Record<string, unknown>): IntegrationResolvedRoute {
  return {
    pattern: '/blog/[...slug]',
    segments: [
      [{ content: 'blog', dynamic: false, spread: false }],
      [{ content: '...slug', dynamic: true, spread: true }],
    ],
    params: ['...slug'],
    type: 'page',
    ...overrides,
  } as unknown as IntegrationResolvedRoute;
}

describe('toRouteInfos', () => {
  it('projects page routes onto RouteInfo with Astro segments, deep-copied', () => {
    const segments = [[{ content: 'blog', dynamic: false, spread: false }]];
    const [info] = toRouteInfos([hookRoute({ segments })]);
    expect(info).toEqual({
      pattern: '/blog/[...slug]',
      segments,
      params: ['...slug'],
    });
    expect(info?.segments).not.toBe(segments);
    expect(info?.segments[0]).not.toBe(segments[0]);
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
});
