import { useQuery } from '@tanstack/react-query';
import type { CollectionRecord } from '../../../core/collections';
import type { FormFieldNode, ValidationIssueRecord } from '../../../core/form-tree';
import type { CollectionsIndex, RouteInfo } from '../../../core/route-resolver';

/** The collections query key — every reader and invalidator imports this. */
export const COLLECTIONS_KEY = ['astroix', 'collections'] as const;

/** The routes query key (the `astro:routes:resolved` capture, #68). */
export const ROUTES_KEY = ['astroix', 'routes'] as const;

/** The per-collection schema-tree query key. */
export const SCHEMA_KEY = ['astroix', 'schema'] as const;

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

/** The schema payload served by `GET /__astroix/content-schema`. */
export interface SchemaPayload {
  collection: string;
  fields: FormFieldNode[];
}

/** A collection's schema walked into the widget tree (TanStack Query, #72). */
export function useContentSchema(collection: string | null) {
  return useQuery({
    queryKey: [...SCHEMA_KEY, collection],
    enabled: collection !== null,
    queryFn: async (): Promise<SchemaPayload> => {
      const response = await fetch(
        `/__astroix/content-schema?collection=${encodeURIComponent(collection ?? '')}`,
      );
      if (!response.ok) throw new Error('schema endpoint failed');
      return (await response.json()) as SchemaPayload;
    },
  });
}

/**
 * safeParse of the draft against the collection's own schema on the server
 * (the same instance the form was generated from). Called on the debounce
 * and on blur — advisory only, issues render inline and gate nothing (US12).
 */
export async function validateDraft(
  collection: string,
  data: unknown,
): Promise<ValidationIssueRecord[]> {
  const response = await fetch(
    `/__astroix/content-validate?collection=${encodeURIComponent(collection)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as { issues?: ValidationIssueRecord[] };
  return payload.issues ?? [];
}
