import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEntryDraft, serializeEntry } from '../../packages/core/src/entry-writer.ts';
import {
  type CollectionsIndex,
  hasCandidateRoutes,
  pickNavigableCandidate,
  type RouteInfo,
  resolveActiveEntry,
} from '../../packages/core/src/route-resolver.ts';
import { spliceText } from '../../packages/core/src/splice-writer.ts';
import type {
  ContentBodyWriteFixture,
  ContentValidateFixture,
  ContentWriteFixture,
  CssScopedSpliceFixture,
  CssSpliceFixture,
  EditConflictFixture,
  EditNegativesFixture,
} from '../behavior-contracts/schema/edit-contract.ts';
import { editFixtureSchemas } from '../behavior-contracts/schema/edit-contract.ts';
import type {
  CollectionsFixture,
  ContentSchemasFixture,
  CssIndexFixture,
  RawTruthFixture,
  RouteResolutionFixture,
  RoutesFixture,
} from '../behavior-contracts/schema/inspection-contract.ts';
import { fixtureSchemas } from '../behavior-contracts/schema/inspection-contract.ts';

/**
 * The readiness contracts leg (#214, AC-1): validates EVERY frozen B1/B2
 * contract family — inspection, edit, conflict, selector, route, and
 * output-byte — through the versioned schemas, and re-derives the derived
 * side of each edit contract with the RETAINED pure modules
 * (packages/core), never with legacy runtime source. The legacy
 * implementation appears in this proof only as the disposable oracle the
 * separate live-comparison leg boots.
 *
 * The freeze suites (e2e/contracts-*.spec.ts) own byte-exact re-derivation
 * from a booted oracle; this leg owns the readiness aggregation: family
 * coverage is total (a manifest fixture missing from every family fails),
 * every family is non-empty (a vacuously-passing family fails), and the
 * frozen evidence is internally consistent under the retained core.
 */

const CONTRACTS_DIR = join('e2e', 'behavior-contracts');

/** The six contract families the retirement gate must hold (#214 AC-1). */
export type ContractFamily =
  | 'inspection'
  | 'edit'
  | 'conflict'
  | 'selector'
  | 'route'
  | 'output-byte';

/** The frozen files each family's evidence lives in (relative to the corpus dir). */
const FAMILY_FIXTURES: Record<ContractFamily, readonly string[]> = {
  // what the system showed: payloads, listings, walked schemas, raw truth
  inspection: [
    'inspection/collections.json',
    'inspection/content-schemas.json',
    'inspection/raw-truth.json',
  ],
  // what it wrote: splices, whole-file writes, advisory validation
  edit: [
    'edit/css-splice.json',
    'edit/css-scoped-splice.json',
    'edit/content-frontmatter-write.json',
    'edit/content-body-write.json',
    'edit/content-validate.json',
    'edit/edit-negatives.json',
  ],
  // the expected-hash guard's rejections and the disk they defended
  conflict: ['edit/css-conflict.json', 'edit/content-conflict.json'],
  // compiled selector identity under both scopedStyleStrategy forms
  selector: ['inspection/css-index.attribute.json', 'inspection/css-index.where.json'],
  // route payloads and entry resolution
  route: ['inspection/routes.json', 'inspection/route-resolution.json'],
  // the byte windows every write leaves untouched, and verbatim landing
  'output-byte': [
    'edit/css-splice.json',
    'edit/css-scoped-splice.json',
    'edit/content-frontmatter-write.json',
    'edit/content-body-write.json',
    'edit/css-conflict.json',
    'edit/content-conflict.json',
    'edit/edit-negatives.json',
  ],
};

/** One family's readiness result — the counts ledger's contract rows. */
export interface FamilyReadiness {
  family: ContractFamily;
  fixtures: readonly string[];
  checks: number;
}

function readFixture(relative: string): string {
  return readFileSync(join(CONTRACTS_DIR, relative), 'utf8');
}

function parseInspection<K extends keyof typeof fixtureSchemas>(name: string): unknown {
  const raw: unknown = JSON.parse(readFixture(`inspection/${name}`));
  const schema = fixtureSchemas[name as K];
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`inspection fixture ${name} fails its schema: ${result.error.message}`);
  }
  return result.data;
}

function parseEdit<K extends keyof typeof editFixtureSchemas>(name: string): unknown {
  const raw: unknown = JSON.parse(readFixture(`edit/${name}`));
  const schema = editFixtureSchemas[name as K];
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`edit fixture ${name} fails its schema: ${result.error.message}`);
  }
  return result.data;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Named assertion accumulator — every family leg records its checks. */
class Checks {
  readonly done: string[] = [];
  constructor(readonly family: ContractFamily) {}
  that(what: string, condition: boolean): void {
    if (!condition) throw new Error(`${this.family}: ${what}`);
    this.done.push(what);
  }
}

// --- per-family validation over the parsed, schema-validated fixtures ---

function validateInspection(checks: Checks): void {
  const collections = parseInspection('collections.json') as CollectionsFixture;
  const schemas = parseInspection('content-schemas.json') as ContentSchemasFixture;
  const rawTruth = parseInspection('raw-truth.json') as RawTruthFixture;

  // collections: served order is code-unit sorted, entries id-sorted, paths confined
  const names = collections.collections.map((collection) => collection.name);
  checks.that(
    'collection names are served in code-unit order',
    [...names].sort().join('\u0000') === names.join('\u0000'),
  );
  for (const collection of collections.collections) {
    const ids = collection.entries.map((entry) => entry.id);
    checks.that(
      `entries of ${collection.name} are id-sorted`,
      [...ids].sort().join('\u0000') === ids.join('\u0000'),
    );
    checks.that(
      `entries of ${collection.name} carry project-relative paths`,
      collection.entries.every(
        (entry) => entry.filePath !== null && !entry.filePath.startsWith('/'),
      ),
    );
  }
  checks.that(
    'the canonical four collections are frozen',
    names.join(',') === 'blog,gallery,homepage,notes',
  );

  // content-schemas: one walk per frozen collection
  checks.that(
    'every frozen collection has a walked schema',
    names.every((name) => schemas.schemas.some((schema) => schema.collection === name)),
  );
  checks.that(
    'the blog walk is non-empty',
    (schemas.schemas.find((s) => s.collection === 'blog')?.fields.length ?? 0) > 0,
  );

  // raw truth: the canonical reads parse through the retained entry-writer
  const hello = rawTruth.reads.find((read) => read.file.endsWith('hello-builder.md'));
  checks.that('the raw-truth corpus froze the canonical blog entry', hello !== undefined);
  if (hello !== undefined) {
    const parsed = parseEntryDraft(hello.contents);
    checks.that(
      'the raw truth parses as an entry draft through the retained core',
      parsed !== null && typeof parsed.data === 'object',
    );
  }
}

function validateSelector(checks: Checks): void {
  const attribute = parseInspection('css-index.attribute.json') as CssIndexFixture;
  const where = parseInspection('css-index.where.json') as CssIndexFixture;

  for (const [name, corpus, cidForm] of [
    ['attribute', attribute, '[data-astro-cid-'],
    ['where', where, ':where(.astro-'],
  ] as const) {
    const scoped = corpus.records.filter((record) => record.scoped);
    checks.that(`the ${name} corpus carries scoped rules`, scoped.length > 0);
    checks.that(
      `every ${name} scoped selector carries the strategy's cid form`,
      scoped.every((record) => record.effectiveSelector?.includes(cidForm) === true),
    );
    checks.that(
      `every ${name} global rule stays unjoined`,
      corpus.records
        .filter((record) => !record.scoped)
        .every((record) => record.effectiveSelector === null),
    );
    checks.that(
      `the ${name} join names the source selector it compiles`,
      scoped.every((record) => record.effectiveSelector?.startsWith(record.selector) === true),
    );
  }

  // identity across strategies: the same source rules, different compiled form
  const key = (record: CssIndexFixture['records'][number]): string =>
    `${record.file}\u0000${record.selector}\u0000${record.range.start}`;
  checks.that(
    'both strategies froze the same source-rule set',
    attribute.records.map(key).sort().join('\u0000') ===
      where.records.map(key).sort().join('\u0000'),
  );
  checks.that(
    'the two corpora freeze different compiled forms (strategy is real)',
    JSON.stringify(attribute.records.map((r) => r.effectiveSelector)) !==
      JSON.stringify(where.records.map((r) => r.effectiveSelector)),
  );
}

function validateRoute(checks: Checks): void {
  const routes = parseInspection('routes.json') as RoutesFixture;
  const resolution = parseInspection('route-resolution.json') as RouteResolutionFixture;
  const collections = parseInspection('collections.json') as CollectionsFixture;

  checks.that(
    'the route payload enumerates the canonical patterns',
    routes.routes.map((route) => route.pattern).join(',') === '/blog/[slug],/blog/[...slug],/',
  );

  // renders live only on prerendered single-param routes (the schema's space)
  for (const route of routes.routes) {
    if (route.params.length === 1 && route.rendering === 'prerendered') {
      checks.that(
        `route ${route.pattern} carries its render enumeration`,
        (route.renders?.length ?? 0) > 0,
      );
    } else {
      checks.that(`route ${route.pattern} carries no renders`, route.renders === undefined);
    }
  }

  // route resolution re-derived through the RETAINED resolver over the
  // frozen payloads — the replacement's truth, not the legacy runtime's
  const collectionsIndex: CollectionsIndex = Object.fromEntries(
    collections.collections.map((collection) => [
      collection.name,
      collection.entries.map((entry) => entry.id),
    ]),
  );
  const routeInfos: ReadonlyArray<RouteInfo> = routes.routes.map((route) => ({ ...route }));
  const seen = new Set<string>();
  const recomputed = [] as RouteResolutionFixture['entryResolutions'];
  for (const collection of collections.collections) {
    for (const entry of collection.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const holders = Object.keys(collectionsIndex).filter((name) =>
        (collectionsIndex[name] ?? []).includes(entry.id),
      );
      const hasCandidates = hasCandidateRoutes(entry.id, routeInfos);
      recomputed.push({
        entryId: entry.id,
        holderCollections: holders,
        candidateUrl: pickNavigableCandidate(entry.id, routeInfos, collectionsIndex),
        hasCandidateRoutes: hasCandidates,
        unrouted: !hasCandidates,
      });
    }
  }
  checks.that(
    'the retained route resolver reproduces every frozen entry resolution',
    JSON.stringify(recomputed) === JSON.stringify(resolution.entryResolutions),
  );
  checks.that(
    'every frozen url probe resolves through the retained resolver',
    resolution.urlProbes.every(
      (probe) =>
        JSON.stringify(resolveActiveEntry(routeInfos, probe.url, collectionsIndex)) ===
        JSON.stringify(probe.resolved ?? null),
    ),
  );
  checks.that(
    'the frozen unrouted truth is the expected trio',
    resolution.entryResolutions
      .filter((row) => row.unrouted)
      .map((row) => row.entryId)
      .sort()
      .join(',') === 'index,scratch,showcase',
  );
}

function validateEdit(checks: Checks): void {
  const splice = parseEdit('css-splice.json') as CssSpliceFixture;
  const scoped = parseEdit('css-scoped-splice.json') as CssScopedSpliceFixture;
  const frontmatter = parseEdit('content-frontmatter-write.json') as ContentWriteFixture;
  const body = parseEdit('content-body-write.json') as ContentBodyWriteFixture;
  const validate = parseEdit('content-validate.json') as ContentValidateFixture;
  const negatives = parseEdit('edit-negatives.json') as EditNegativesFixture;

  // css splice: the retained splice-writer re-derives the frozen after bytes
  const spliced = spliceText(splice.baseline.contents, {
    start: splice.edit.range.start,
    end: splice.edit.range.end,
    replacement: splice.edit.replacement,
  });
  checks.that(
    'css-splice: retained splice-writer output equals the frozen after bytes',
    spliced === splice.after.contents,
  );
  checks.that(
    'css-splice: the frozen hash revisions the after bytes',
    sha256(splice.after.contents) === splice.after.hash,
  );

  // scoped splice: same re-derivation plus the compiled-form join
  const scopedSpliced = spliceText(scoped.baseline.contents, {
    start: scoped.edit.range.start,
    end: scoped.edit.range.end,
    replacement: scoped.edit.replacement,
  });
  checks.that(
    'css-scoped-splice: retained splice-writer output equals the frozen after bytes',
    scopedSpliced === scoped.after.contents,
  );
  checks.that(
    'css-scoped-splice: the renamed rule re-serves the replacement selector',
    scoped.indexAfter.selector === scoped.edit.replacement,
  );

  // content writes: the retained entry-writer re-derives the posted bytes
  for (const [name, fixture] of [
    ['content-frontmatter-write', frontmatter],
    ['content-body-write', body],
  ] as const) {
    const baseline = parseEntryDraft(fixture.baseline.contents);
    checks.that(
      `${name}: the baseline parses through the retained entry-writer`,
      baseline !== null,
    );
    if (baseline === null) return;
    const written = serializeEntry({
      raw: fixture.baseline.contents,
      baseline,
      draft: fixture.draft,
    });
    checks.that(
      `${name}: retained entry-writer output equals the frozen posted bytes`,
      written === fixture.written.contents,
    );
    checks.that(
      `${name}: the frozen hash revisions the after bytes`,
      sha256(fixture.after.contents) === fixture.after.hash,
    );
    checks.that(
      `${name}: the posted bytes landed verbatim`,
      fixture.after.contents === fixture.written.contents,
    );
  }

  // advisory validation: issues never gate the write
  checks.that(
    'content-validate: the clean probe carries no issues',
    validate.valid.response.ok && validate.valid.response.issues.length === 0,
  );
  checks.that(
    'content-validate: the invalid probe flags issues',
    !validate.invalid.response.ok && validate.invalid.response.issues.length > 0,
  );
  checks.that(
    'content-validate: the never-gated proof wrote the invalid data verbatim',
    validate.advisoryWrite.response.status === 200 &&
      validate.advisoryWrite.after.contents === validate.advisoryWrite.written.contents,
  );

  // the 400 taxonomy with the disk proven untouched
  checks.that(
    'edit-negatives: every frozen negative answers 400',
    negatives.cases.every((neg) => neg.response.status === 400),
  );
  checks.that(
    'edit-negatives: the disk bytes survived every negative untouched',
    negatives.disk.before.contents === negatives.disk.after.contents,
  );
}

function validateConflict(checks: Checks): void {
  for (const [name, fixture] of [
    ['css-conflict', parseEdit('css-conflict.json') as EditConflictFixture],
    ['content-conflict', parseEdit('content-conflict.json') as EditConflictFixture],
  ] as const) {
    checks.that(`${name}: the stale attempt is refused with 409`, fixture.response.status === 409);
    checks.that(
      `${name}: the 409 names the guard's reason`,
      fixture.response.body.error === 'file changed on disk',
    );
    checks.that(
      `${name}: the 409 hands back the raced disk truth`,
      fixture.response.body.contents === fixture.interference.contents,
    );
    checks.that(
      `${name}: the refused write retained the raced disk`,
      fixture.retained.contents === fixture.interference.contents &&
        fixture.retained.hash === fixture.interference.hash,
    );
    checks.that(
      `${name}: the refused attempt hashed the pre-race baseline (stale by construction)`,
      fixture.attempt.expectedHash === fixture.baseline.hash,
    );
  }
}

function validateOutputBytes(checks: Checks): void {
  // the splice window: every byte outside the range survives identically
  for (const [name, fixture] of [
    ['css-splice', parseEdit('css-splice.json') as CssSpliceFixture],
    ['css-scoped-splice', parseEdit('css-scoped-splice.json') as CssScopedSpliceFixture],
  ] as const) {
    const prefix = fixture.baseline.contents.slice(0, fixture.edit.range.start);
    const suffix = fixture.baseline.contents.slice(fixture.edit.range.end);
    checks.that(
      `${name}: bytes outside the splice window survive byte-identical`,
      fixture.after.contents.startsWith(prefix) && fixture.after.contents.endsWith(suffix),
    );
  }
  // whole-file writes: posted bytes equal disk bytes, frontmatter surgical
  const frontmatter = parseEdit('content-frontmatter-write.json') as ContentWriteFixture;
  const body = parseEdit('content-body-write.json') as ContentBodyWriteFixture;
  checks.that(
    'content-frontmatter-write: every preserved line is byte-identical in baseline and written bytes',
    frontmatter.preserved.every(
      (line) =>
        frontmatter.baseline.contents.includes(line) && frontmatter.after.contents.includes(line),
    ),
  );
  checks.that(
    'content-body-write: the whole frontmatter block survives byte-identical',
    body.baseline.contents.startsWith(body.preservedPrefix) &&
      body.after.contents.startsWith(body.preservedPrefix),
  );
  // conflicts and negatives leave the disk exactly as the race left it
  const negatives = parseEdit('edit-negatives.json') as EditNegativesFixture;
  checks.that(
    'edit-negatives: no negative ever touched the disk',
    negatives.disk.before.contents === negatives.disk.after.contents,
  );
}

const FAMILY_VALIDATORS: Record<ContractFamily, (checks: Checks) => void> = {
  inspection: validateInspection,
  selector: validateSelector,
  route: validateRoute,
  edit: validateEdit,
  conflict: validateConflict,
  'output-byte': validateOutputBytes,
};

/**
 * Runs every family's validation and returns the family ledger. Throws on
 * the first failed check (named); asserts total manifest coverage and
 * per-family non-emptiness — a vacuous or partial readiness proof cannot
 * pass.
 */
export function validateContractFamilies(): readonly FamilyReadiness[] {
  // every fixture parses through its schema before any family logic runs
  for (const name of Object.keys(fixtureSchemas)) parseInspection(name);
  for (const name of Object.keys(editFixtureSchemas)) parseEdit(name);

  // total coverage: every frozen manifest file belongs to at least one family
  const manifestFiles = [
    ...Object.keys(fixtureSchemas).map((name) => `inspection/${name}`),
    ...Object.keys(editFixtureSchemas).map((name) => `edit/${name}`),
  ];
  const covered = new Set(Object.values(FAMILY_FIXTURES).flat());
  const uncovered = manifestFiles.filter((file) => !covered.has(file));
  if (uncovered.length > 0) {
    throw new Error(`readiness family map does not cover: ${uncovered.join(', ')}`);
  }

  const ledger: FamilyReadiness[] = [];
  for (const family of Object.keys(FAMILY_VALIDATORS) as ContractFamily[]) {
    const fixtures = FAMILY_FIXTURES[family];
    if (fixtures.length === 0) throw new Error(`contract family ${family} is empty — vacuous`);
    for (const fixture of fixtures) readFixture(fixture); // existence, not just schema memory
    const checks = new Checks(family);
    FAMILY_VALIDATORS[family](checks);
    if (checks.done.length === 0) throw new Error(`contract family ${family} ran zero checks`);
    ledger.push({ family, fixtures, checks: checks.done.length });
  }
  return ledger;
}
