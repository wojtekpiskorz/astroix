import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IntegrationResolvedRoute } from 'astro';
import type { RouteInfo } from '../core/route-resolver';
import { type ApiContext, type ApiHandler, json } from './api';

/**
 * Shared container between the `astro:routes:resolved` hook (writer) and the
 * REST layer (reader). The hook's sync projection lands in `current`
 * immediately; `renders` is filled into it later by the background
 * enumeration pass (`route-enumeration.ts`) — `GET /__astroix/routes` never
 * awaits that pass (#119).
 */
export interface RoutesState {
  /** The served payload — the sync hook projection, `renders` merged in place. */
  current: RouteInfo[];
  /**
   * The hook's raw capture — the enumeration's input (entrypoint,
   * `isPrerendered`, params). Replaced whole on every hook run.
   */
  captured: readonly IntegrationResolvedRoute[];
  /**
   * Fired by `captureRoutes` on every hook capture with whether the served
   * projection changed (preserved `renders` aside); set by the enumeration
   * registration, which owns the server handles (latest server wins across
   * dev restarts — the integration instance persists).
   */
  onCapture?: (changed: boolean) => void;
}

/**
 * Projects hook routes to the `RouteInfo` contract of `src/core/route-resolver`
 * (single source of truth per the core-first ruling on PR #77): page routes
 * only — the resolver's contract filters out `endpoint`/`redirect`/`fallback`
 * types and Astro-core `internal`-origin routes (e.g. the dev server-islands
 * route `/_server-islands/[name]`, which would otherwise resolve as a
 * same-shape candidate and navigate to a 404, #109) — with Astro's own
 * `segments` parse carried along, deep-copied so no live core object is held
 * between hook runs. `rendering` rides from the hook's `isPrerendered` —
 * free and synchronous (#119); `renders` is not projected here: enumeration
 * owns it.
 */
export function toRouteInfos(routes: readonly IntegrationResolvedRoute[]): RouteInfo[] {
  return routes.flatMap((route) => {
    if (!isProjectPageRoute(route)) return [];
    return [
      {
        pattern: route.pattern,
        segments: route.segments.map((segment) => segment.map((part) => ({ ...part }))),
        params: [...route.params],
        rendering: route.isPrerendered ? 'prerendered' : 'on-demand',
      },
    ];
  });
}

/**
 * The routes-payload membership rule — the same filter the enumeration pass
 * applies over the raw capture, so served patterns and enumerated patterns
 * can never drift.
 */
export function isProjectPageRoute(route: IntegrationResolvedRoute): boolean {
  return route.type === 'page' && route.origin !== 'internal';
}

/**
 * The `astro:routes:resolved` writer: replaces the raw capture, reprojects
 * `current`, and preserves already-enumerated `renders` by pattern — a
 * re-capture with unchanged routes leaves the served payload byte-identical
 * (no push), and a stale `renders` can only keep a candidate alive through
 * the ms-scale window until the identity-checked pass re-verifies it, never
 * fire the marker wrongly (unknown never fires, #119's silent-never-wrong).
 */
export function captureRoutes(
  state: RoutesState,
  routes: readonly IntegrationResolvedRoute[],
): void {
  state.captured = routes;
  const previous = new Map(state.current.map((info) => [info.pattern, info.renders]));
  const next = toRouteInfos(routes).map((info) => {
    const renders = previous.get(info.pattern);
    return renders === undefined ? info : { ...info, renders };
  });
  const changed = !samePayload(next, state.current);
  state.current = next;
  state.onCapture?.(changed);
}

/**
 * Merges enumeration results into the served payload: an entry sets `renders`
 * (a `[]` is knowably-dead truth, not unknown), a missing entry means the
 * route's enumeration did not positively succeed — `renders` comes off.
 * Returns whether the payload changed (the caller's push signal).
 */
export function applyRenders(
  state: RoutesState,
  renders: ReadonlyMap<string, ReadonlyArray<string>>,
): boolean {
  let changed = false;
  state.current = state.current.map((info) => {
    const values = renders.get(info.pattern);
    if (values === undefined) {
      if (info.renders !== undefined) changed = true;
      return { ...info, renders: undefined };
    }
    if (samePayload(values, info.renders)) return info;
    changed = true;
    return { ...info, renders: [...values] };
  });
  return changed;
}

/** Payload equality over the projection's small JSON shape (stable key order). */
function samePayload(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `GET /__astroix/routes` — the routes array captured from
 * `astro:routes:resolved` (re-runs on route changes via dev restarts).
 * Served synchronously from the container: the background enumeration fills
 * `renders` into the same array slots, and its completion pushes the
 * `astroix:routes-changed` WS event so the chrome refetches (#119). A
 * routing concern, not a content one: the concept grows from here — the
 * resolver (#69) and the overrides-file naming both key on route patterns.
 */
export const routesHandlers: readonly ApiHandler[] = [
  { method: 'GET', path: '/routes', handle: handleRoutes },
];

async function handleRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ApiContext,
): Promise<void> {
  json(res, 200, ctx.routes.current);
}
