import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CollectionsFixture, CssIndexFixture, RoutesFixture } from './inspection-contract.ts';
import { CONTRACT_VERSION, fixtureSchemas } from './inspection-contract.ts';

/**
 * The inspection-contract validators under the unit doctrine (#216 left
 * them Playwright-side as interval debt; #217's carried directive moves
 * schema validation to vitest — pure zod, no browser, no oracle). Every
 * frozen fixture parses against its schema, and the identity invariants
 * the corpus exists to preserve reject what normalizes them away; the
 * manifest agreement and hygiene legs stay with the freeze spec
 * (contracts-inspection.spec.ts), which owns the oracle comparison.
 */

const INSPECTION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'inspection');

function frozen(name: string): unknown {
  return JSON.parse(readFileSync(join(INSPECTION_DIR, name), 'utf8')) as unknown;
}

describe('the frozen inspection corpus validates against the versioned schema', () => {
  for (const name of Object.keys(fixtureSchemas)) {
    it(`${name} parses and carries the contract version`, () => {
      const result = fixtureSchemas[name as keyof typeof fixtureSchemas].safeParse(frozen(name));
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
        true,
      );
      expect((frozen(name) as { contractVersion: string }).contractVersion).toBe(CONTRACT_VERSION);
    });
  }
});

describe('the inspection schema rejects normalized-away identity', () => {
  it('rejects a scoped effective selector stripped of its cid form', () => {
    const data = frozen('css-index.attribute.json') as CssIndexFixture;
    const scoped = data.records.find((record) => record.scoped);
    expect(scoped).toBeDefined();
    if (scoped !== undefined) scoped.effectiveSelector = scoped.selector;
    expect(fixtureSchemas['css-index.attribute.json'].safeParse(data).success).toBe(false);
  });

  it('rejects reordered collection entries', () => {
    const data = frozen('collections.json') as CollectionsFixture;
    const blog = data.collections.find((collection) => collection.name === 'blog');
    expect(blog).toBeDefined();
    if (blog !== undefined) blog.entries.reverse();
    expect(fixtureSchemas['collections.json'].safeParse(data).success).toBe(false);
  });

  it('rejects a zero-param route carrying renders', () => {
    const data = frozen('routes.json') as RoutesFixture;
    const home = data.routes.find((route) => route.pattern === '/');
    expect(home).toBeDefined();
    if (home !== undefined) home.renders = [];
    expect(fixtureSchemas['routes.json'].safeParse(data).success).toBe(false);
  });

  it('rejects traversal file paths', () => {
    const data = frozen('css-index.attribute.json') as CssIndexFixture;
    const record = data.records[0];
    expect(record).toBeDefined();
    if (record !== undefined) record.file = '../outside.css';
    expect(fixtureSchemas['css-index.attribute.json'].safeParse(data).success).toBe(false);
  });
});
