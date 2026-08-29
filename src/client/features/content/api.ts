import { useQuery } from '@tanstack/react-query';

/** The collections query key — every reader and invalidator imports this. */
export const COLLECTIONS_KEY = ['astroix', 'collections'] as const;

/** GET /__astroix/collections entries, client-projected (src/node/content.ts). */
export interface CollectionsEntry {
  id: string;
  filePath: string | null;
  data: unknown;
  body: string | null;
}

export interface CollectionsPayload {
  name: string;
  hasSchema: boolean;
  entries: CollectionsEntry[];
}

/** Collections with parsed entries — the Content vertical's server data. */
export function useCollections() {
  return useQuery({
    queryKey: COLLECTIONS_KEY,
    queryFn: async (): Promise<CollectionsPayload[]> => {
      const response = await fetch('/__astroix/collections');
      if (!response.ok) return [];
      return (await response.json()) as CollectionsPayload[];
    },
  });
}
