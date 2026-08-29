import { useQuery } from '@tanstack/react-query';
import type { CollectionRecord } from '../../../core/collections';

/** The collections query key — every reader and invalidator imports this. */
export const COLLECTIONS_KEY = ['astroix', 'collections'] as const;

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
