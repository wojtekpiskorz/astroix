import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toIssueRecords, walkSchemaFields } from '@wojciechpiskorz/astroix-core';
import type { CompositionServer } from '../composition';
import type { FreshRunnerOutcome } from '../fresh-runner';
import { withFreshRunner } from '../fresh-runner';
import type { ModuleRunnerLike } from '../seam-readers';
import {
  type CollectionDefinitionSeams,
  type ContentApiSeams,
  getCollectionRejection,
  moduleEvaluationRejection,
  readContentApi,
  readContentConfig,
  readServedEntries,
  readZodNamespace,
  SEAM_CONTENT_API,
  SEAM_CONTENT_CONFIG,
  SEAM_ZOD_NAMESPACE,
  type ServedEntry,
  type ZodNamespaceSeams,
} from './content-probes';
import type {
  ContentCollectionResult,
  ContentCompatibilityDiagnostic,
  ContentEntryResult,
  ContentInspectionResult,
  ContentSchemaResult,
} from './content-result';
import { type CollectionTruth, collectionRevision, passRevision } from './content-revisions';
import { readEntryBaseline } from './entry-baselines';
import {
  classifyCollectionCategory,
  type LoadedCollectionSchema,
  loadCollectionSchema,
} from './schema-loading';

/**
 * The content inspection pass (#228, ADR-0005 "Real configuration and
 * duplicate hooks"): one fresh Vite module runner over the composition
 * server — which is already `getViteConfig()` over the managed
 * project's REAL configuration (the accepted duplicate-hook boundary,
 * #202/#206) — importing `astro:content`, the project's own content
 * config (`src/content.config.ts`, the certified fixture form), and —
 * only when a schema factory exists — `astro/zod` for the certified
 * `image()` stub. Every version-sensitive surface enters through the
 * fail-closed probes; every per-collection category failure becomes a
 * structured compatibility diagnostic while the rest of the pass stays
 * certified; and the runner is closed on every exit path with the
 * #206 cleanup proof attached to the outcome.
 */

/** The content config's certified location — a fixed form, never a path search. */
const CONTENT_CONFIG_MODULE = 'src/content.config.ts';

/**
 * Inspects the managed project's content: collections, entries,
 * schemas, revisions, and compatibility diagnostics, from one
 * fresh-runner pass over the composition server. The outcome carries
 * the fresh-runner cleanup evidence (#206 discipline, proven on every
 * exit path by `withFreshRunner`).
 */
export async function inspectContent(
  composition: CompositionServer,
): Promise<FreshRunnerOutcome<ContentInspectionResult>> {
  return withFreshRunner(
    {
      createServerModuleRunner: composition.seams.vite.createServerModuleRunner,
      ssrEnvironment: composition.server.environments.ssr,
    },
    (runner) => runContentPass(runner, composition.seams.projectRoot),
  );
}

/** Everything the pass body threads to one collection's inspection. */
interface PassContext {
  readonly contentApi: ContentApiSeams;
  readonly zod: ZodNamespaceSeams | null;
  readonly projectRoot: string;
}

/** The pass body — everything inside the fresh runner's lifetime. */
async function runContentPass(
  runner: ModuleRunnerLike,
  projectRoot: string,
): Promise<ContentInspectionResult> {
  const contentApi = readContentApi(await importContentApi(runner));
  const definitions = await loadDefinitions(runner, projectRoot);
  const zod = definitionsNeedZod(definitions)
    ? readZodNamespace(await importZodNamespace(runner))
    : null;
  const context: PassContext = { contentApi, zod, projectRoot };

  const collections: ContentCollectionResult[] = [];
  const diagnostics: ContentCompatibilityDiagnostic[] = [];
  for (const name of codeUnitSorted(definitions.keys())) {
    // Names come from the definitions map's own keys — the get is total.
    const inspected = await inspectCollection(
      name,
      definitions.get(name) as CollectionDefinitionSeams,
      context,
    );
    if (inspected.outcome === 'diagnostic') diagnostics.push(inspected.diagnostic);
    else collections.push(inspected.result);
  }

  return {
    collections,
    diagnostics,
    revision: passRevision(collections, diagnostics),
  };
}

/** One collection's inspection: certified data, or the diagnostic that names why not. */
async function inspectCollection(
  name: string,
  definition: CollectionDefinitionSeams,
  context: PassContext,
): Promise<
  | { readonly outcome: 'result'; readonly result: ContentCollectionResult }
  | { readonly outcome: 'diagnostic'; readonly diagnostic: ContentCompatibilityDiagnostic }
> {
  const category = classifyCollectionCategory(name, definition);
  if (category.outcome === 'unsupported') {
    return { outcome: 'diagnostic', diagnostic: category.diagnostic };
  }

  const schema = await loadCollectionSchema(name, definition, context.zod);
  if (schema.outcome === 'unsupported') {
    return { outcome: 'diagnostic', diagnostic: schema.diagnostic };
  }

  const entries = readServedEntries(await serveCollection(context.contentApi, name));
  const entryResults: ContentEntryResult[] = [];
  for (const entry of codeUnitSortedById(entries)) {
    entryResults.push(await inspectEntry(entry, context.projectRoot, schema.loaded));
  }
  // The collection's own truth carries its revision — no placeholder a
  // later stage must remember to replace.
  const truth: CollectionTruth = {
    name,
    entries: entryResults,
    schema: schemaResult(schema.loaded),
  };
  return { outcome: 'result', result: { ...truth, revision: collectionRevision(truth) } };
}

/** One entry: the served projection beside its file baseline and real-schema validation. */
async function inspectEntry(
  entry: ServedEntry,
  projectRoot: string,
  schema: LoadedCollectionSchema,
): Promise<ContentEntryResult> {
  if (entry.filePath === null) {
    return { ...entry, revision: null, issues: null };
  }
  const baseline = await readEntryBaseline(projectRoot, entry.filePath);
  if (baseline === null) {
    return { ...entry, revision: null, issues: null };
  }
  const issues =
    schema.schema === null || baseline.raw === null
      ? null
      : await validateWithProjectSchema(schema.schema, baseline.raw.data);
  return { ...entry, revision: baseline.revision, issues };
}

/** The project's actual schema validating the entry's raw truth — its own parse, its own issues. */
async function validateWithProjectSchema(
  schema: NonNullable<LoadedCollectionSchema['schema']>,
  rawData: unknown,
): Promise<ContentEntryResult['issues']> {
  const parsed = await schema.safeParseAsync(rawData);
  if (parsed.success) return [];
  const issues = parsed.error?.issues;
  if (issues === undefined || issues.length === 0) {
    // zod's contract populates issues on every failure; an issue-less
    // failure would serialize like a clean pass, which is a verdict the
    // schema never produced. Unreachable with the certified zod — fail
    // loudly rather than invent or silence a verdict.
    throw new Error('the project schema failed validation without issue records');
  }
  return toIssueRecords(issues);
}

function schemaResult(schema: LoadedCollectionSchema): ContentSchemaResult {
  return {
    declared: schema.declared,
    fields: walkSchemaFields(schema.schema, { isImage: schema.isImage }),
  };
}

async function serveCollection(contentApi: ContentApiSeams, name: string): Promise<unknown> {
  try {
    return await contentApi.getCollection(name);
  } catch (cause) {
    throw getCollectionRejection(name, cause);
  }
}

async function importContentApi(runner: ModuleRunnerLike): Promise<unknown> {
  try {
    return await runner.import('astro:content');
  } catch (cause) {
    throw moduleEvaluationRejection(
      SEAM_CONTENT_API,
      'the astro:content module with a getCollection export',
      cause,
    );
  }
}

async function importZodNamespace(runner: ModuleRunnerLike): Promise<unknown> {
  try {
    return await runner.import('astro/zod');
  } catch (cause) {
    throw moduleEvaluationRejection(
      SEAM_ZOD_NAMESPACE,
      'the astro/zod module (the project zod namespace)',
      cause,
    );
  }
}

async function loadDefinitions(
  runner: ModuleRunnerLike,
  projectRoot: string,
): Promise<ReadonlyMap<string, CollectionDefinitionSeams>> {
  const configId = pathToFileURL(join(projectRoot, CONTENT_CONFIG_MODULE)).href;
  let moduleExports: unknown;
  try {
    moduleExports = await runner.import(configId);
  } catch (cause) {
    throw moduleEvaluationRejection(
      SEAM_CONTENT_CONFIG,
      'the content config module (src/content.config.ts) with a collections export',
      cause,
    );
  }
  return readContentConfig(moduleExports);
}

function definitionsNeedZod(definitions: ReadonlyMap<string, CollectionDefinitionSeams>): boolean {
  for (const definition of definitions.values()) {
    if (typeof definition.schema === 'function') return true;
  }
  return false;
}

/** Code-unit sort — the frozen served order for collection names. */
function codeUnitSorted(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Code-unit sort by id — the frozen served order for entries. */
function codeUnitSortedById<T extends { id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
