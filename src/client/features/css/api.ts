import { useQuery } from '@tanstack/react-query';
import type { IndexPayloadRecord } from '../../../core/matcher';

/** The indexed CSS rule payload served by GET /__astroix/index. */
export function useIndexPayload() {
  return useQuery({
    queryKey: ['astroix', 'index-payload'],
    queryFn: async (): Promise<IndexPayloadRecord[]> => {
      const response = await fetch('/__astroix/index');
      if (!response.ok) return [];
      return (await response.json()) as IndexPayloadRecord[];
    },
  });
}
