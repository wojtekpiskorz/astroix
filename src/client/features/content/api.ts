import { useQuery } from '@tanstack/react-query';
import type { CollectionRecord } from '../../../core/collections';
import type { CollectionsIndex, RouteInfo } from '../../../core/route-resolver';

/** The collections query key — every reader and invalidator imports this. */
export const COLLECTIONS_KEY = ['astroix', 'collections'] as const;

/** The routes query key (the `astro:routes:resolved` capture, #68). */
export const ROUTES_KEY = ['astroix', 'routes'] as const;

/** Collections with parsed entries — the Content vertical's server data. */
export function useCollections() {
  return useQuery({
    queryKey: COLLECTIONS_KEY,
    queryFn: async (): Promise<CollectionRecord[]> => {
      const response = await fetch('/__astroix/collections');
      if (!response.ok) return [];
      return (await response.json()) as CollectionRecord[];
    },
  });
}

/** The route patterns route resolution runs over — entry ids and canvas URLs join on them (#71). */
export function useRoutes() {
  return useQuery({
    queryKey: ROUTES_KEY,
    queryFn: async (): Promise<RouteInfo[]> => {
      const response = await fetch('/__astroix/routes');
      if (!response.ok) return [];
      return (await response.json()) as RouteInfo[];
    },
  });
}

/** The served collections payload reshaped into the resolver's index (route-resolver contract). */
export function toCollectionsIndex(collections: ReadonlyArray<CollectionRecord>): CollectionsIndex {
  const index: Record<string, string[]> = {};
  for (const collection of collections) {
    index[collection.name] = collection.entries.map((entry) => entry.id);
  }
  return index;
}
