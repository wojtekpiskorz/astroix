import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCssIndex } from '@wojciechpiskorz/astroix-core';
import { afterAll, expect, it } from 'vitest';
import {
  CID_FORM,
  type CssIndexFixture,
  cssIndexFixtureSchema,
} from '../../../../../e2e/behavior-contracts/schema/inspection-contract.ts';
import { AdapterError } from '../../../astro-project-adapter/adapter-error';
import {
  CERTIFIED_ASTRO_PIN,
  CERTIFIED_VITE_PIN,
  type CertificationStrategy,
  installProject,
  readHookLog,
  runManagedDevServer,
  type StagedProject,
  stageProject,
} from '../../../astro-project-adapter/certification/stage-project';
import {
  comparableRecords,
  compileCssEntries,
  type IndexPayloadRecord,
  joinIndexPayload,
  readSourceFiles,
} from '../../../astro-project-adapter/certification/styles-join';
import { CERTIFIED_PAIRS } from '../../../astro-project-adapter/certified-pair';
import {
  createCompositionServer,
  type ProjectRuntimeSeams,
} from '../../../astro-project-adapter/composition';
import {
  type RunnerCleanupEvidence,
  withFreshRunner,
} from '../../../astro-project-adapter/fresh-runner';
import { resolveInstalledPair } from '../../../astro-project-adapter/installed-pair';
import { certifyPairBeforeConfig } from '../../../astro-project-adapter/pair-gate';
import {
  type ModuleRunnerLike,
  type RouteSeamEntry,
  readDevCssEntries,
  readRouteEntries,
  type ViteServerLike,
} from '../../../astro-project-adapter/seam-readers';
import { stageStubInstall } from '../stub-install';

/**
 * The adapter certification suite (#225): proves, over a REAL npm install
 * of the exact certified pair (`astro@7.2.10 + vite@8.2.2`) in disposable
 * temp copies of the canonical fixture, that the AstroProjectAdapter's
 * surfaces produce contract-shaped results and fail closed everywhere
 * the charter demands. The matrix (one certification, exact pair, never
 * a range):
 *
 *   1. pair gate       — positive over the real install; negatives
 *                        (astro drift, vite drift) rejected at the
 *                        resolution layer BEFORE the config callback.
 *   2. duplicate hooks — the managed dev server executes the real
 *                        project config, then the composition executes
 *                        it again: the append-only integration observes
 *                        both executions from distinct processes (the
 *                        accepted #202/#206 cost); an exclusive-claim
 *                        integration fails the second execution with the
 *                        named diagnostic (the accepted boundary).
 *   3. surfaces        — routes/content/schemas and both scoped-style
 *                        strategies joined through fresh runners; the
 *                        styles payloads equal the frozen corpora
 *                        (attribute `[data-astro-cid-*]`, where
 *                        `:where(.astro-*)`) and validate against the
 *                        contract schema.
 *   4. fresh runners   — every pass closes its runner and restores the
 *                        hot transport's send accounting — no residue
 *                        across passes.
 *
 * The production topology order holds per project: the managed dev
 * server boots first (it owns the content sync — the data store the
 * composition's `astro:content` reads read), the composition inspects
 * after. Run: `npm run certify:adapter` (never part of `npm test` —
 * real installs, minutes-scale). Legs run sequentially and share staged
 * state.
 */

const CORPUS_DIR = join(process.cwd(), 'e2e', 'behavior-contracts', 'inspection');
const scratch: string[] = [];
const keepWorkspaces = process.env.ASTROIX_KEEP_CERTIFICATION === '1';

let attribute: StagedProject;
let managedPid: number;

afterAll(async () => {
  if (keepWorkspaces) {
    console.log(`ASTROIX_KEEP_CERTIFICATION=1 — keeping workspaces:\n${scratch.join('\n')}`);
    return;
  }
  await Promise.all(
    scratch.map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })),
  );
});

it('certifies the exact installed pair over the real install and rejects drift before project config', async () => {
  attribute = await stageAndInstall('attribute', 'append');

  // Positive: the pair resolves from the managed project's own installation.
  const installed = await resolveInstalledPair(attribute.root);
  expect(installed).toEqual({ astro: CERTIFIED_ASTRO_PIN, vite: CERTIFIED_VITE_PIN });
  let configRuns = 0;
  const certified = await certifyPairBeforeConfig({ projectRoot: attribute.root }, async (pair) => {
    configRuns += 1;
    return pair;
  });
  expect(configRuns).toBe(1);
  expect(certified).toEqual({ astro: CERTIFIED_ASTRO_PIN, vite: CERTIFIED_VITE_PIN });

  // Negatives: stub manifests at the RESOLUTION layer only (#225 — the
  // behavior layer is never faked); each drift rejects before the config
  // callback runs, carrying detected pair, certified pairs, rejected contract.
  for (const drift of [
    { astro: '7.2.11', vite: CERTIFIED_VITE_PIN },
    { astro: CERTIFIED_ASTRO_PIN, vite: '8.2.1' },
    { astro: '7.3.0', vite: '8.3.0' },
  ]) {
    await withStubInstall(drift, async (stubRoot) => {
      let stubConfigRuns = 0;
      const rejection = await certifyPairBeforeConfig({ projectRoot: stubRoot }, async () => {
        stubConfigRuns += 1;
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(stubConfigRuns).toBe(0);
      expect(rejection).toBeInstanceOf(AdapterError);
      const error = rejection as AdapterError;
      expect(error.code).toBe('uncertified-pair');
      expect(error.details).toEqual({
        detected: drift,
        certified: CERTIFIED_PAIRS.map((pair) => ({ astro: pair.astro, vite: pair.vite })),
        rejectedContract:
          'exact Astro/Vite pair certification must pass before project config executes',
      });
      expect(error.message).toContain(`detected astro@${drift.astro} + vite@${drift.vite}`);
      expect(error.message).toContain('astro@7.2.10 + vite@8.2.2');
    });
  }
});

it('executes the real project config twice — the managed dev server, then the composition (accepted duplicate)', async () => {
  // Duplicate execution #1: the project's own dev server boots its real
  // config (and owns the content sync the composition reads after).
  const managed = await runManagedDevServer({
    projectRoot: attribute.root,
    hookLog: attribute.hookLog,
  });
  managedPid = managed.pid;
  const observations = await readHookLog(attribute.hookLog);
  const managedRuns = observations.filter((observation) => observation.pid === managed.pid);
  expect(managedRuns.length).toBeGreaterThanOrEqual(1);
  expect(managedRuns[0]?.processLocalConfigSetupCount).toBe(1);
  expect([0, 143].includes(managed.exitCode ?? -1) || managed.exitSignal === 'SIGTERM').toBe(true);
});

it('surfaces routes, content, schemas, and attribute-strategy styles through fresh runners', async () => {
  // Duplicate execution #2: the composition executes the same real config.
  const composition = await createCompositionServer(attribute.root);
  const compositionPid = process.pid;
  try {
    expect(compositionPid).not.toBe(managedPid);
    const observations = await readHookLog(attribute.hookLog);
    const compositionRuns = observations.filter(
      (observation) => observation.pid === compositionPid,
    );
    expect(compositionRuns.length).toBeGreaterThanOrEqual(1);
    expect(compositionRuns[0]?.processLocalConfigSetupCount).toBe(1);

    // Pass 1 (fresh runner): routes, content, schemas.
    const contentPass = await withFreshRunner(
      {
        createServerModuleRunner: composition.seams.vite.createServerModuleRunner,
        ssrEnvironment: composition.server.environments.ssr,
      },
      async (runner) => inspectContent(runner, attribute.root),
    );
    assertRunnerEvidence(contentPass.evidence);

    // Routes: the seam sees astro's injected internals too; the project's
    // own page routes are exactly the patterns the frozen routes corpus
    // freezes.
    const projectRoutes = contentPass.result.routes.filter((route) =>
      route.component.startsWith('src/'),
    );
    expect(projectRoutes.map((route) => route.pattern).sort()).toEqual([
      '/',
      '/blog/[...slug]',
      '/blog/[slug]',
    ]);
    expect(projectRoutes.every((route) => route.type === 'page')).toBe(true);

    // Content: the collections corpus's blog and homepage rows, verbatim
    // (zod projection with defaults filled, dates serialized).
    const corpus = await loadCorpus<CollectionsCorpus>('collections.json');
    const byName = new Map(corpus.collections.map((collection) => [collection.name, collection]));
    expect(contentPass.result.blog.map(serializeEntry)).toEqual(byName.get('blog')?.entries);
    expect(contentPass.result.homepage.map(serializeEntry)).toEqual(
      byName.get('homepage')?.entries,
    );

    // Schemas: every schematized corpus collection is present; schema
    // presence is detectable and notes is the schema-less one.
    expect(contentPass.result.schemaNames).toEqual(['blog', 'gallery', 'homepage']);
    expect(contentPass.result.schemalessCollections).toEqual(['notes']);

    // Pass 2 (fresh runner): the attribute-strategy styles join.
    const stylesPayload = await inspectStyles(
      composition.server,
      composition.seams,
      attribute.root,
    );
    await assertStylesParity(stylesPayload, 'attribute');
  } finally {
    await composition.close();
  }
});

it('joins contract-shaped styles under the where strategy', async () => {
  const where = await stageAndInstall('where', 'append');
  const composition = await createCompositionServer(where.root);
  try {
    const payload = await inspectStyles(composition.server, composition.seams, where.root);
    await assertStylesParity(payload, 'where');
  } finally {
    await composition.close();
  }
});

it('rejects an incompatible duplicate hook with the named diagnostic', async () => {
  const exclusive = await stageAndInstall('attribute', 'exclusive');
  // The managed dev server's config execution claims the exclusive side
  // effect first; the composition's config execution then fails closed
  // with the named diagnostic (#202/#206 accepted boundary).
  const managed = await runManagedDevServer({
    projectRoot: exclusive.root,
    hookLog: exclusive.hookLog,
  });
  expect(await readFileOrNull(exclusive.exclusivePath)).toBe(`${managed.pid}\n`);

  await expect(createCompositionServer(exclusive.root)).rejects.toThrow(
    /certification incompatible duplicate hook: exclusive side effect already claimed/,
  );
});

// ——— the shared inspection legs ———

async function inspectStyles(
  server: ViteServerLike,
  seams: ProjectRuntimeSeams,
  projectRoot: string,
): Promise<IndexPayloadRecord[]> {
  // Routes pass (fresh runner): find the index route and its dev-css module.
  const routesPass = await withFreshRunner(
    {
      createServerModuleRunner: seams.vite.createServerModuleRunner,
      ssrEnvironment: server.environments.ssr,
    },
    async (runner) => {
      const routes = readRouteEntries(await runner.import('virtual:astro:routes'));
      const indexRoute = projectRoute(routes, '/');
      const cssEntries = readDevCssEntries(
        await runner.import(seams.getDevCSSModuleName(indexRoute.component)),
      );
      return { component: indexRoute.component, cssEntries };
    },
  );
  assertRunnerEvidence(routesPass.evidence);

  // Compiled CSS (fresh runner closed before the client transforms; the
  // page is primed in the client environment so its scoped style modules
  // are transformable there — #206 constraint 2):
  const compiled = await compileCssEntries(
    server.environments.client,
    routesPass.result.cssEntries,
    {
      routeComponent: routesPass.result.component,
    },
  );
  const staticRecords = buildCssIndex(await readSourceFiles(projectRoot));
  return joinIndexPayload(staticRecords, compiled, {
    requiredScopedFiles: [routesPass.result.component],
  });
}

interface ContentInspection {
  readonly routes: readonly RouteSeamEntry[];
  readonly blog: readonly ContentEntry[];
  readonly homepage: readonly ContentEntry[];
  readonly schemaNames: readonly string[];
  readonly schemalessCollections: readonly string[];
}

interface ContentEntry {
  readonly id: string;
  readonly filePath: string | null;
  readonly data: unknown;
  readonly body: string | null;
}

async function inspectContent(
  runner: ModuleRunnerLike,
  projectRoot: string,
): Promise<ContentInspection> {
  const routes = readRouteEntries(await runner.import('virtual:astro:routes'));
  const contentModule = (await runner.import('astro:content')) as {
    getCollection?: (name: string) => Promise<ContentEntry[]>;
  };
  if (typeof contentModule.getCollection !== 'function') {
    throw new Error('astro:content has no getCollection');
  }
  const [blog, homepage] = await Promise.all([
    contentModule.getCollection('blog'),
    contentModule.getCollection('homepage'),
  ]);
  const configModule = (await runner.import(
    pathToFileURL(join(projectRoot, 'src', 'content.config.ts')).href,
  )) as { collections?: Record<string, { schema?: unknown }> };
  const definitions = configModule.collections;
  if (definitions === undefined || typeof definitions !== 'object') {
    throw new Error('the content config has no collections object');
  }
  return {
    routes,
    blog: blog.map(projectEntry),
    homepage: homepage.map(projectEntry),
    schemaNames: Object.keys(definitions)
      .filter((name) => definitions[name]?.schema !== undefined)
      .sort(),
    schemalessCollections: Object.keys(definitions)
      .filter((name) => definitions[name]?.schema === undefined)
      .sort(),
  };
}

// ——— assertions and small helpers ———

/** The seam also carries astro's injected internal routes — project pages are the fixture's own. */
function projectRoute(routes: readonly RouteSeamEntry[], pattern: string): RouteSeamEntry {
  const route = routes.find(
    (candidate) => candidate.pattern === pattern && candidate.component.startsWith('src/'),
  );
  if (route === undefined) {
    throw new Error(`the project route ${pattern} is absent from virtual:astro:routes`);
  }
  return route;
}

function assertRunnerEvidence(evidence: RunnerCleanupEvidence): void {
  expect(evidence.closedAfterClose).toBe(true);
  expect(evidence.sendListenersAfterClose).toBe(evidence.sendListenersBefore);
}

async function assertStylesParity(
  payload: readonly IndexPayloadRecord[],
  strategy: CertificationStrategy,
): Promise<void> {
  // Contract-shaped: the payload validates against the frozen corpus
  // schema, cid form included (attribute `[data-astro-cid-*]`, where
  // `:where(.astro-*)`).
  cssIndexFixtureSchema.parse({
    contractVersion: '1.0.0',
    kind: 'css-index',
    scopedStyleStrategy: strategy,
    records: payload,
  });
  const scoped = payload.filter((record) => record.scoped && record.effectiveSelector !== null);
  expect(scoped.length).toBeGreaterThan(0);
  for (const record of scoped) {
    expect(record.effectiveSelector).toContain(CID_FORM[strategy]);
  }
  for (const record of payload) {
    if (!record.scoped) expect(record.effectiveSelector).toBeNull();
  }

  // Parity: the payload equals the frozen corpus for this strategy,
  // scope-hash normalized on BOTH sides by the same comparator (hashes
  // are per-path, not contract identity).
  const corpus = await loadCorpus<CssIndexFixture>(`css-index.${strategy}.json`);
  expect(comparableRecords(payload)).toEqual(comparableRecords(corpus.records));
}

async function stageAndInstall(
  strategy: CertificationStrategy,
  mode: 'append' | 'exclusive',
): Promise<StagedProject> {
  const staged = await stageProject({ strategy, mode });
  scratch.push(staged.root);
  await installProject(staged.root);
  return staged;
}

interface CollectionsCorpus {
  collections: Array<{
    name: string;
    entries: Array<{ id: string; filePath: string | null; body: string | null; data: unknown }>;
  }>;
}

function projectEntry(entry: ContentEntry): ContentEntry {
  return {
    id: entry.id,
    filePath: entry.filePath === undefined ? null : entry.filePath,
    data: entry.data,
    body: typeof entry.body === 'string' ? entry.body : null,
  };
}

function serializeEntry(entry: ContentEntry): unknown {
  // The corpus serializes the zod projection (dates as ISO strings).
  return JSON.parse(
    JSON.stringify(entry, (_key, value: unknown) =>
      value instanceof Date ? value.toISOString() : value,
    ),
  );
}

async function loadCorpus<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(CORPUS_DIR, name), 'utf8')) as T;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function withStubInstall(
  pair: { astro: string; vite: string },
  run: (stubRoot: string) => Promise<void>,
): Promise<void> {
  const stubRoot = await stageStubInstall(pair);
  scratch.push(stubRoot);
  await run(stubRoot);
}
