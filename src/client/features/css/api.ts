import { useQuery } from '@tanstack/react-query';
import type { IndexPayloadRecord } from '../../../core/matcher';

/** The index-payload query key — every reader and invalidator imports this. */
export const INDEX_PAYLOAD_KEY = ['astroix', 'index-payload'] as const;

/** The indexed CSS rule payload served by GET /__astroix/index. */
export function useIndexPayload() {
  return useQuery({
    queryKey: INDEX_PAYLOAD_KEY,
    queryFn: async (): Promise<IndexPayloadRecord[]> => {
      const response = await fetch('/__astroix/index');
      if (!response.ok) return [];
      return (await response.json()) as IndexPayloadRecord[];
    },
  });
}
