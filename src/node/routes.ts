import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IntegrationResolvedRoute } from 'astro';
import type { RouteInfo } from '../core/route-resolver';
import { type ApiContext, type ApiHandler, json } from './api';

/** Shared container between the `astro:routes:resolved` hook (writer) and the REST layer (reader). */
export interface RoutesState {
  current: RouteInfo[];
}

/**
 * Projects hook routes to the `RouteInfo` contract of `src/core/route-resolver`
 * (single source of truth per the core-first ruling on PR #77): page routes
 * only — the resolver's contract filters out `endpoint`/`redirect`/`fallback`
 * types at the payload — with Astro's own `segments` parse carried along,
 * deep-copied so no live core object is held between hook runs.
 */
export function toRouteInfos(routes: readonly IntegrationResolvedRoute[]): RouteInfo[] {
  return routes.flatMap((route) => {
    if (route.type !== 'page') return [];
    return [
      {
        pattern: route.pattern,
        segments: route.segments.map((segment) => segment.map((part) => ({ ...part }))),
        params: [...route.params],
      },
    ];
  });
}

/**
 * `GET /__astroix/routes` — the routes array captured from
 * `astro:routes:resolved` (re-runs on route changes via dev restarts).
 * A routing concern, not a content one: the concept grows from here — the
 * resolver (#69) and the overrides-file naming both key on route patterns.
 */
export const routesHandlers: readonly ApiHandler[] = [
  {
    method: 'GET',
    path: '/routes',
    handle: async (
      _req: IncomingMessage,
      res: ServerResponse,
      _url: URL,
      ctx: ApiContext,
    ): Promise<void> => {
      json(res, 200, ctx.routes.current);
    },
  },
];
