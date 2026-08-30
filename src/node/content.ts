import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'astro/zod';
import { createServerModuleRunner } from 'vite';
import type { CollectionEntryRecord, CollectionRecord } from '../core/collections';
import {
  type IssueLike,
  toIssueRecords,
  type ValidationIssueRecord,
  walkSchemaFields,
} from '../core/form-tree';
import { type ApiContext, type ApiHandler, json, readJsonBody } from './api';
import { writeGuarded } from './rest';

/** The content endpoints: read-side (core-reuse §3) and the auto-write (Impl #9). */
export const contentHandlers: readonly ApiHandler[] = [
  { method: 'GET', path: '/collections', handle: handleCollections },
  { method: 'GET', path: '/content-schema', handle: handleContentSchema },
  { method: 'POST', path: '/content-validate', handle: handleContentValidate },
  { method: 'POST', path: '/content-write', handle: handleContentWrite },
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
  const payload = await withContentConfig(ctx, async (runner, configModule) => {
    const contentModule = (await runner.import('astro:content')) as RawContentModule;
    return assembleCollectionsPayload(configModule, contentModule);
  });
  json(res, 200, payload);
}

/**
 * The stateless-doctrine sequence every content endpoint starts with: one
 * fresh module runner per request (nothing held between requests — core
 * clears its caches on invalidation), importing the user's content config
 * as the runner evaluates it. The runner closes when `use` settles: its
 * transport pins a `send` listener on the ssr hot channel, and a fresh
 * runner per request leaks one listener each otherwise (#146).
 */
async function withContentConfig<T>(
  ctx: ApiContext,
  use: (
    runner: ReturnType<typeof createServerModuleRunner>,
    configModule: RawContentConfig | null,
  ) => Promise<T>,
): Promise<T> {
  const runner = createServerModuleRunner(ctx.server.environments.ssr);
  try {
    const configPath = findContentConfigPath(ctx.srcDir);
    const configModule =
      configPath === null ? null : ((await runner.import(configPath)) as RawContentConfig);
    return await use(runner, configModule);
  } finally {
    // teardown of dev-only listener noise must not mask the endpoint's result
    await runner.close().catch(() => {});
  }
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
 * `GET /__astroix/content-schema?collection=<name>` — the collection's schema
 * walked into the JSON field tree the chrome renders widgets from (#72).
 * Schema-less collections and non-object roots degrade to a root raw field:
 * every collection opens in the builder regardless of its schema's shape.
 */
async function handleContentSchema(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<void> {
  const loaded = await loadCollectionSchema(ctx, url.searchParams.get('collection'));
  if (loaded === null) {
    json(res, 400, { error: 'collection query parameter is missing or unknown' });
    return;
  }
  const fields = walkSchemaFields(loaded.resolved.schema, {
    isImage: (schema) => loaded.resolved.imageStubs.has(schema as object),
  });
  json(res, 200, { collection: loaded.name, fields });
}

/**
 * `POST /__astroix/content-validate?collection=<name>` — safeParse of the
 * chrome's draft against the same schema instance the form was generated
 * from (the repo-mapping doctrine: no parallel schema reconstruction
 * client-side). Advisory only: issues render inline and never gate anything
 * (US12) — this slice has no write to gate.
 */
async function handleContentValidate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<void> {
  const loaded = await loadCollectionSchema(ctx, url.searchParams.get('collection'));
  if (loaded === null) {
    json(res, 400, { error: 'collection query parameter is missing or unknown' });
    return;
  }
  let data: unknown;
  try {
    data = await readJsonBody(req);
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : 'unreadable body' });
    return;
  }
  const issues = await validateDraft(loaded.resolved.schema, data);
  json(res, 200, { ok: issues.length === 0, issues });
}

/** Minimal structural surface of a zod schema's async parse. */
interface AsyncSafeParse {
  safeParseAsync?: (
    input: unknown,
  ) => Promise<{ success: true } | { success: false; error: { issues: readonly IssueLike[] } }>;
}

/**
 * `POST /__astroix/content-write` — the content auto-write's whole-file write
 * (spec Impl #9): the chrome serializes the entry (core's entry-writer) and
 * posts the full bytes with the hash of the baseline it serialized from.
 * `writeGuarded` owns the shared hash-guard skeleton (Impl #10).
 */
async function handleContentWrite(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ApiContext,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : 'unreadable body' });
    return;
  }
  const { file, contents, expected } = parseWriteBody(body);
  if (file === null || contents === null) {
    json(res, 400, { error: 'expected { file, contents }' });
    return;
  }
  await writeGuarded(res, ctx, file, expected, () => contents);
}

function parseWriteBody(body: unknown): {
  file: string | null;
  contents: string | null;
  expected: string | null;
} {
  if (body === null || typeof body !== 'object') {
    return { file: null, contents: null, expected: null };
  }
  const { file, contents, expected } = body as Record<string, unknown>;
  return {
    file: typeof file === 'string' ? file : null,
    contents: typeof contents === 'string' ? contents : null,
    expected: typeof expected === 'string' ? expected : null,
  };
}

/**
 * Runs safeParseAsync and projects the issues. A schema that cannot parse
 * under introspection validates as clean — validation is advisory, and a
 * throwing parse must not 500 the typing loop.
 */
export async function validateDraft(
  schema: unknown,
  data: unknown,
): Promise<ValidationIssueRecord[]> {
  const parse = (schema as AsyncSafeParse | null)?.safeParseAsync;
  if (parse === undefined) return [];
  try {
    const result = await parse.call(schema, data);
    return result.success ? [] : toIssueRecords(result.error.issues);
  } catch {
    return [];
  }
}

/** A collection schema resolved for walking: the instance plus our image stubs. */
export interface ResolvedCollectionSchema {
  schema: unknown;
  imageStubs: Set<object>;
}

/** Astro's function-schema service bag — only the `image` seam is consumed. */
type SchemaFunction = (services: { image: () => unknown }) => unknown;

/**
 * Resolves a collection's schema out of the evaluated content config:
 * static schemas pass through; function schemas (astro's `({ image }) => …`
 * form) are called once with our own image stubs — `z.any()` instances whose
 * Set membership the walker reads through the injected `isImage` predicate.
 * The real `image()` is `z.string().transform(...)` with a Vite-bound
 * resolver, unwalkable and indistinguishable from user transforms — the
 * permissive stub keeps safeParse off read-only fields while marking them.
 * A function schema that throws under introspection degrades to no schema
 * (the raw-field root) — every collection still opens.
 */
export function resolveCollectionSchema(
  configModule: RawContentConfig | null,
  name: string,
): ResolvedCollectionSchema | null {
  const definition = toDefinitionMap(configModule?.collections)[name];
  if (definition === undefined) return null;
  const imageStubs = new Set<object>();
  const raw = definition.schema;
  if (typeof raw !== 'function') return { schema: raw ?? null, imageStubs };
  try {
    const schema = (raw as SchemaFunction)({ image: () => imageStub(imageStubs) });
    return { schema, imageStubs };
  } catch {
    return { schema: null, imageStubs };
  }
}

function imageStub(stubs: Set<object>): unknown {
  // fresh instance per call — membership never collides with a user's z.any()
  const stub = z.any();
  stubs.add(stub);
  return stub;
}

/** Fresh-runner schema load shared by the schema and validate endpoints. */
async function loadCollectionSchema(
  ctx: ApiContext,
  name: string | null,
): Promise<{ name: string; resolved: ResolvedCollectionSchema } | null> {
  if (name === null) return null;
  return withContentConfig(ctx, async (_runner, configModule) => {
    const resolved = resolveCollectionSchema(configModule, name);
    return resolved === null ? null : { name, resolved };
  });
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
