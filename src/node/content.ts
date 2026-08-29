import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createServerModuleRunner } from 'vite';
import { type ApiContext, type ApiHandler, json } from './api';

/** A single collection entry as served to the chrome (core's getCollection shape, JSON-projected). */
export interface CollectionEntryRecord {
  /** Slugified source path (glob loader id), e.g. `2024/post`. */
  id: string;
  /** Root-relative posix source path, or null for store entries without one. */
  filePath: string | null;
  /** Parsed frontmatter (zod output). */
  data: unknown;
  /** Raw markdown body, or null for data-only entries. */
  body: string | null;
}

/** A collection with its entries and schema presence (spec Impl #4 — read side). */
export interface CollectionRecord {
  name: string;
  hasSchema: boolean;
  entries: CollectionEntryRecord[];
}

/** The content read-side endpoint (core-reuse §3). */
export const contentHandlers: readonly ApiHandler[] = [
  { method: 'GET', path: '/collections', handle: handleCollections },
];

/**
 * `GET /__astroix/collections` — collections + entries through core's own
 * `astro:content` module: parsed `data`, `body`, `filePath` per entry, plus
 * schema presence from the content config. **Stateless doctrine**: a fresh
 * module runner per request, no module held between requests — core clears
 * its caches on invalidation, so anything we cache would go stale. Raw entry
 * bytes go through the root-confined `GET /__astroix/file` (rest.ts).
 */
async function handleCollections(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ApiContext,
): Promise<void> {
  const runner = createServerModuleRunner(ctx.server.environments.ssr);
  const configPath = findContentConfigPath(ctx.srcDir);
  const configModule =
    configPath === null ? null : ((await runner.import(configPath)) as RawContentConfig);
  const contentModule = (await runner.import('astro:content')) as RawContentModule;
  json(res, 200, await assembleCollectionsPayload(configModule, contentModule));
}

/** The user's `content.config` module as the runner evaluates it. */
export interface RawContentConfig {
  collections?: unknown;
}

/** `astro:content` as the runner evaluates it — only the surface this module consumes. */
export interface RawContentModule {
  getCollection?: (name: string) => Promise<unknown[]>;
}

/**
 * Joins the config's collection definitions (names, schema presence) with
 * core's `getCollection` results. Deterministic: collections and entries are
 * name/id-sorted regardless of store iteration order.
 */
export async function assembleCollectionsPayload(
  configModule: RawContentConfig | null,
  contentModule: RawContentModule,
): Promise<CollectionRecord[]> {
  const definitions = toDefinitionMap(configModule?.collections);
  const collections: CollectionRecord[] = [];
  for (const name of Object.keys(definitions).sort()) {
    const entries = await loadEntries(contentModule, name);
    collections.push({ name, hasSchema: definitions[name]?.schema !== undefined, entries });
  }
  return collections;
}

/** `Record<string, { schema?: unknown }>` or an empty record — never throws on a malformed config. */
function toDefinitionMap(collections: unknown): Record<string, { schema?: unknown }> {
  if (typeof collections !== 'object' || collections === null) return {};
  const definitions: Record<string, { schema?: unknown }> = {};
  for (const [name, definition] of Object.entries(collections)) {
    if (typeof definition === 'object' && definition !== null) {
      definitions[name] = definition as { schema?: unknown };
    }
  }
  return definitions;
}

async function loadEntries(
  contentModule: RawContentModule,
  name: string,
): Promise<CollectionEntryRecord[]> {
  const raw = (await contentModule.getCollection?.(name)) ?? [];
  return (
    raw
      .filter(
        (entry): entry is { id: string; filePath?: unknown; data?: unknown; body?: unknown } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === 'string',
      )
      .map((entry) => ({
        id: entry.id,
        filePath: typeof entry.filePath === 'string' ? entry.filePath : null,
        data: entry.data ?? null,
        body: typeof entry.body === 'string' ? entry.body : null,
      }))
      // Code-unit order, like the collection-name sort above — localeCompare
      // follows process collation, which can order ids per machine.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  );
}

/**
 * The content config path, mirroring core's search order
 * (`src/content.config.{mjs,js,mts,ts}`, then the legacy `src/content/config.*`).
 */
export function findContentConfigPath(srcDir: string): string | null {
  const candidates = [
    ['content.config.mjs', 'content.config.js', 'content.config.mts', 'content.config.ts'].map(
      (name) => join(srcDir, name),
    ),
    ['config.ts', 'config.js', 'config.mjs', 'config.mts'].map((name) =>
      join(srcDir, 'content', name),
    ),
  ].flat();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
