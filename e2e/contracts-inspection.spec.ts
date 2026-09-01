import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type {
  CollectionsFixture,
  CssIndexFixture,
  RouteResolutionFixture,
  RoutesFixture,
} from './behavior-contracts/schema/inspection-contract.ts';
import {
  CONTRACT_VERSION,
  fixtureSchemas,
} from './behavior-contracts/schema/inspection-contract.ts';
import {
  assertNoForbiddenArtifacts,
  CORPUS_FILES,
  CORPUS_MANIFEST,
  captureInspectionCorpus,
  serializeFixture,
  skipWithoutChromium,
} from './contract-oracle/live-capture.ts';
import { MAIN_PORT, WHERE_PORT, withOracleServer } from './contract-oracle/oracle-server.ts';

/**
 * The inspection behavior-contract suite (#216, lane B1, ADR-0010): the
 * frozen corpus under e2e/behavior-contracts/inspection/ is (a) validated
 * against the versioned schema, (b) hygiene-scanned for the artifacts AC-4
 * forbids, and (c) re-derived from a fresh disposable-oracle run through
 * the exact capture pipeline that froze it — byte-for-byte. That last leg
 * is the freeze: the retired integration (running only as the disposable
 * oracle) is the evidence producer, and the identity-preserving negatives
 * prove the comparison cannot pass a corpus that normalized selector
 * identity, rule order, source ranges, collection order, or route identity
 * away.
 *
 * Server boots go through e2e/contract-oracle/oracle-server.ts — the
 * no-E2E interval's playwright.config.ts carries no webServers (ADR-0010,
 * amended 2026-09-01), so the suite owns its evidence producers' lifecycle.
 */

const FIXTURE_DIR = join('e2e', 'behavior-contracts', 'inspection');

function frozenText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function frozenJson<T>(name: string): T {
  return JSON.parse(frozenText(name)) as T;
}

function expectSchemaRejects(
  name: keyof typeof fixtureSchemas,
  mutate: (data: unknown) => void,
  because: string,
): void {
  const data = JSON.parse(frozenText(name));
  mutate(data);
  const result = fixtureSchemas[name].safeParse(data);
  expect(result.success, `${name}: ${because}`).toBe(false);
}

test('every frozen inspection fixture validates against the versioned schema and carries no forbidden artifacts', () => {
  // The manifest is the single enumeration of the frozen set — it must agree
  // with the schema registry exactly, so a fixture cannot be frozen without
  // also being re-frozen (and a schema without a manifest entry, which would
  // silently never re-derive, fails here too).
  expect(CORPUS_MANIFEST.map((entry) => entry.file).sort()).toEqual(
    Object.keys(fixtureSchemas).sort(),
  );
  for (const [name, schema] of Object.entries(fixtureSchemas)) {
    const text = frozenText(name);
    const data = JSON.parse(text);
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(`${name} fails its schema: ${JSON.stringify(result.error.issues)}`);
    }
    expect(data.contractVersion, `${name} carries the schema's contractVersion`).toBe(
      CONTRACT_VERSION,
    );
    assertNoForbiddenArtifacts(text, name);
  }
});

test('the schema rejects fixtures that normalize identity away (negative cases)', () => {
  // selector identity: a joined scoped selector must carry the strategy's cid form
  expectSchemaRejects(
    'css-index.attribute.json',
    (data) => {
      const scoped = (data as CssIndexFixture).records.find((record) => record.scoped);
      if (scoped === undefined) throw new Error('no scoped record to mutate');
      scoped.effectiveSelector = scoped.selector;
    },
    'a scoped effective selector stripped of its [data-astro-cid- form must be rejected',
  );
  expectSchemaRejects(
    'css-index.where.json',
    (data) => {
      const scoped = (data as CssIndexFixture).records.find((record) => record.scoped);
      if (scoped === undefined) throw new Error('no scoped record to mutate');
      scoped.effectiveSelector = `${scoped.selector}[data-astro-cid-x]`;
    },
    'an attribute-form selector under the where strategy must be rejected',
  );
  // the join's invariant: global rules never carry an effective selector
  expectSchemaRejects(
    'css-index.attribute.json',
    (data) => {
      const global = (data as CssIndexFixture).records.find((record) => !record.scoped);
      if (global === undefined) throw new Error('no global record to mutate');
      global.effectiveSelector = global.selector;
    },
    'a global record with a joined effective selector must be rejected',
  );
  // source ranges: start must precede end
  expectSchemaRejects(
    'css-index.attribute.json',
    (data) => {
      const record = (data as CssIndexFixture).records[0];
      if (record === undefined) throw new Error('no record to mutate');
      record.range = { start: record.range.end, end: record.range.start };
    },
    'an inverted source range must be rejected',
  );
  // confinement shape: file fields are project-relative
  expectSchemaRejects(
    'css-index.attribute.json',
    (data) => {
      const record = (data as CssIndexFixture).records[0];
      if (record === undefined) throw new Error('no record to mutate');
      record.file = '../outside.css';
    },
    'a traversal path must be rejected',
  );
  // collection order: entries are id-sorted by code unit
  expectSchemaRejects(
    'collections.json',
    (data) => {
      const blog = (data as CollectionsFixture).collections.find((c) => c.name === 'blog');
      if (blog === undefined) throw new Error('no blog collection to mutate');
      blog.entries.reverse();
    },
    'reordered collection entries must be rejected',
  );
  // rendering state: renders is the enumeration space of prerendered single-param routes only
  expectSchemaRejects(
    'routes.json',
    (data) => {
      const home = (data as RoutesFixture).routes.find((route) => route.pattern === '/');
      if (home === undefined) throw new Error('no static route to mutate');
      home.renders = [];
    },
    'a zero-param route carrying renders must be rejected',
  );
  // AC-4 hygiene is structural: a host/port-bearing URL must be rejected
  expectSchemaRejects(
    'route-resolution.json',
    (data) => {
      const probe = (data as RouteResolutionFixture).urlProbes[0];
      if (probe === undefined) throw new Error('no probe to mutate');
      probe.url = 'http://localhost:4392/';
    },
    'an absolute URL with host and port must be rejected',
  );
});

test('the freeze comparison is order- and identity-sensitive (mutation negatives)', () => {
  const cssText = frozenText(CORPUS_FILES.cssIndex);
  const css = frozenJson<CssIndexFixture>(CORPUS_FILES.cssIndex);
  const reversedRecords = structuredClone(css);
  reversedRecords.records.reverse();
  expect(
    serializeFixture(reversedRecords),
    'rule order is preserved, not normalized away',
  ).not.toBe(cssText);

  const shiftedRange = structuredClone(css);
  const firstRecord = shiftedRange.records[0];
  if (firstRecord !== undefined) {
    firstRecord.range = { ...firstRecord.range, start: firstRecord.range.start + 1 };
  }
  expect(serializeFixture(shiftedRange), 'source ranges are preserved exactly').not.toBe(cssText);

  const strippedCid = structuredClone(css);
  const scoped = strippedCid.records.find((record) => record.scoped);
  if (scoped !== undefined && scoped.effectiveSelector !== null) {
    scoped.effectiveSelector = scoped.selector;
  }
  expect(serializeFixture(strippedCid), 'selector identity is preserved exactly').not.toBe(cssText);

  const collectionsText = frozenText(CORPUS_FILES.collections);
  const collections = frozenJson<CollectionsFixture>(CORPUS_FILES.collections);
  const swappedCollections = structuredClone(collections);
  const firstCollection = swappedCollections.collections[0];
  const secondCollection = swappedCollections.collections[1];
  if (firstCollection === undefined || secondCollection === undefined) {
    throw new Error('expected at least two collections to swap');
  }
  swappedCollections.collections[0] = secondCollection;
  swappedCollections.collections[1] = firstCollection;
  expect(serializeFixture(swappedCollections), 'collection order is preserved').not.toBe(
    collectionsText,
  );

  const routesText = frozenText(CORPUS_FILES.routes);
  const routes = frozenJson<RoutesFixture>(CORPUS_FILES.routes);
  const renamedPattern = structuredClone(routes);
  const slugRoute = renamedPattern.routes.find((route) => route.pattern === '/blog/[slug]');
  if (slugRoute !== undefined) slugRoute.pattern = '/blog/[id]';
  expect(serializeFixture(renamedPattern), 'route identity (the pattern) is preserved').not.toBe(
    routesText,
  );
});

test('freeze: the main oracle still produces the frozen inspection corpus byte-for-byte', {
  tag: '@oracle-boot',
}, async () => {
  skipWithoutChromium();
  test.setTimeout(240_000);
  await withOracleServer('main', MAIN_PORT, async (handle) => {
    const corpus = await captureInspectionCorpus({
      base: handle.base,
      root: handle.dir,
      strategy: 'attribute',
    });
    for (const { file, leg } of CORPUS_MANIFEST.filter((entry) => entry.strategy === 'attribute')) {
      expect(serializeFixture(corpus[leg]), `${file} drifted from the frozen corpus`).toBe(
        frozenText(file),
      );
    }
  });
});

test('freeze: the where-strategy oracle still produces the frozen scoped selector form', {
  tag: '@oracle-boot',
}, async () => {
  skipWithoutChromium();
  test.setTimeout(240_000);
  await withOracleServer('where', WHERE_PORT, async (handle) => {
    const corpus = await captureInspectionCorpus({
      base: handle.base,
      root: handle.dir,
      strategy: 'where',
    });
    for (const { file, leg } of CORPUS_MANIFEST.filter((entry) => entry.strategy === 'where')) {
      expect(serializeFixture(corpus[leg]), `${file} drifted from the frozen corpus`).toBe(
        frozenText(file),
      );
    }
  });
});
