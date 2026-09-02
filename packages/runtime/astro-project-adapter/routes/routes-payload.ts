import type { RouteMetadataEntry, RouteSegmentPart } from './route-metadata';

/**
 * The typed routes payload (#229): the pure projection from seam metadata
 * to the frozen routes contract's shape (`e2e/behavior-contracts/
 * inspection/routes.json`, schema `routesFixtureSchema`) — pattern,
 * Astro's own segments parse, param names, rendering mode, and the
 * enumeration's `renders`. The payload is plain JSON data by construction:
 * no component path, no raw module export, no Vite or runner handle ever
 * enters it (ADR-0005: `inspect()` exposes typed patterns and enumeration
 * results, nothing else).
 *
 * Membership and the renders space are the frozen contract's own rules,
 * restated from the retired projection that froze them: project page
 * routes only (`type === 'page'`, Astro-core `internal` origin excluded),
 * and `renders` only on prerendered single-param routes — its presence
 * elsewhere is a normalized-away rendering state the contract refuses.
 */

/** Per-route rendering mode — rides synchronously from the seam's prerender flag. */
export type RouteRendering = 'prerendered' | 'on-demand';

/**
 * One served route — the frozen contract's `routeInfo`. `renders` is the
 * `getStaticPaths` enumeration of a prerendered single-param route:
 * present only on positively-succeeded enumeration (`[]` = knowably
 * renders nothing), absent = unknown.
 */
export interface RouteInfo {
  /** Astro route pattern — identity and display; resolution reads `segments`. */
  readonly pattern: string;
  /** Astro's own parse of the pattern: parts per segment. */
  readonly segments: readonly (readonly RouteSegmentPart[])[];
  /** Param names as Astro reports them (`...slug` for a rest param). */
  readonly params: readonly string[];
  readonly rendering: RouteRendering;
  readonly renders?: readonly string[];
}

/**
 * The routes-payload membership rule: page routes that are not Astro-core
 * internals (the dev server-islands route would otherwise ride along as a
 * same-shape candidate). The projection and the enumeration pass apply
 * the same filter, so served patterns and enumerated patterns cannot drift.
 */
export function isProjectPageRoute(entry: RouteMetadataEntry): boolean {
  return entry.type === 'page' && entry.origin !== 'internal';
}

/**
 * Prerendered single-param project page routes are the payload's `renders`
 * space — on-demand routes' `getStaticPaths` is dead code at render, and
 * multi-param or static routes are outside the supported fixture contract.
 */
export function isEnumeratable(entry: RouteMetadataEntry): boolean {
  return isProjectPageRoute(entry) && entry.prerender && entry.params.length === 1;
}

/** Projects seam metadata to the typed payload — project page routes, seam order, no `renders` yet. */
export function toRouteInfos(metadata: readonly RouteMetadataEntry[]): readonly RouteInfo[] {
  return metadata.flatMap((entry) => {
    if (!isProjectPageRoute(entry)) return [];
    return [
      {
        pattern: entry.pattern,
        segments: entry.segments.map((segment) => segment.map((part) => ({ ...part }))),
        params: [...entry.params],
        rendering: entry.prerender ? 'prerendered' : 'on-demand',
      },
    ];
  });
}

/**
 * Joins enumeration results into the payload: an entry sets `renders` on
 * its route (`[]` is knowably-dead truth, not unknown); a missing entry
 * means that route's enumeration did not positively succeed — `renders`
 * comes off. Routes outside the renders space never carry it.
 */
export function withRenders(
  infos: readonly RouteInfo[],
  renders: ReadonlyMap<string, readonly string[]>,
): readonly RouteInfo[] {
  return infos.map((info) => {
    const values = renders.get(info.pattern);
    if (values === undefined || !(info.params.length === 1 && info.rendering === 'prerendered')) {
      return omitRenders(info);
    }
    return { ...info, renders: [...values] };
  });
}

function omitRenders(info: RouteInfo): RouteInfo {
  if (info.renders === undefined) return info;
  const { renders: _renders, ...rest } = info;
  return rest;
}
