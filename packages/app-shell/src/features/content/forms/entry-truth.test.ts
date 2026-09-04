import { describe, expect, it } from 'vitest';
import type { FormFieldNode } from '../../../../../core/src/form-tree.ts';
import { inspectionFixture } from '../../../presentation/fixtures.ts';
import { bindEntryTruth } from './entry-truth.ts';

/**
 * The forms slice's E4 binding tests (#252, J2): the fail-closed law
 * over the payload interior — the frozen corpora (the B1 collections +
 * content-schemas fixtures, extended with the E4 revision/issues
 * fields the runtime serves) are the truth, and every drift leg binds
 * to the drift outcome, never a heuristic parse.
 */

const collectionsFixture = inspectionFixture('collections.json');
const schemasFixture = inspectionFixture('content-schemas.json');

const REVISION = 'f'.repeat(64);
const COLLECTION_REVISION = 'e'.repeat(64);

/** Builds one E4-shaped payload over the frozen corpora's truth for the given collections. */
function payloadFor(collectionNames: readonly string[]): unknown {
  return {
    collections: collectionNames.map((name) => {
      const frozen = collectionsFixture.collections.find((entry) => entry.name === name);
      if (frozen === undefined) throw new Error(`frozen corpus has no collection ${name}`);
      const schema = schemasFixture.schemas.find((entry) => entry.collection === name);
      return {
        name,
        entries: frozen.entries.map((entry) => ({
          id: entry.id,
          filePath: `src/content/${name}/${entry.id}.md`,
          data: entry.data,
          body: entry.body,
          revision: REVISION,
          issues: [],
        })),
        schema: {
          declared: frozen.hasSchema,
          fields: schema === undefined ? [] : schema.fields,
        },
        revision: COLLECTION_REVISION,
      };
    }),
    diagnostics: [],
    revision: 'd'.repeat(64),
  };
}

describe('bindEntryTruth', () => {
  it('binds the frozen blog truth: the walked tree, the inspected values, the revision, the issues verdict', () => {
    const bound = bindEntryTruth(payloadFor(['blog']), 'blog', 'hello-builder');
    expect(bound.outcome).toBe('truth');
    if (bound.outcome !== 'truth') return;
    expect(bound.truth.fields.map((node: FormFieldNode) => node.path)).toEqual([
      'title',
      'date',
      'tags',
      'tone',
      'priority',
      'featured',
      'meta',
      'aside',
    ]);
    expect(bound.truth.values).toEqual({
      title: 'Hello builder',
      date: '2026-08-26T00:00:00.000Z',
      tags: ['meta'],
      tone: 'bold',
      priority: 0,
      featured: false,
    });
    expect(bound.truth.revision).toBe(REVISION);
    expect(bound.truth.collectionRevision).toBe(COLLECTION_REVISION);
    expect(bound.truth.schemaDeclared).toBe(true);
    expect(bound.truth.inspectedIssues).toEqual([]);
    expect(bound.truth.body).toBe('First fixture post — flat id.');
  });

  it('binds a null revision and null issues (the file-less / schema-less carried truths)', () => {
    const payload = payloadFor(['notes']);
    (payload as { collections: { entries: unknown[] }[] }).collections[0]?.entries.push({
      id: 'store-entry',
      filePath: null,
      data: { any: 'shape' },
      body: null,
      revision: null,
      issues: null,
    });
    const bound = bindEntryTruth(payload, 'notes', 'store-entry');
    expect(bound.outcome).toBe('truth');
    if (bound.outcome !== 'truth') return;
    expect(bound.truth.revision).toBeNull();
    expect(bound.truth.inspectedIssues).toBeNull();
    expect(bound.truth.schemaDeclared).toBe(false);
  });

  it("binds the project's own issue verdict verbatim", () => {
    const payload = payloadFor(['blog']) as {
      collections: { entries: { id: string; issues: unknown }[] }[];
    };
    const entry = payload.collections[0]?.entries.find(
      (candidate) => candidate.id === 'hello-builder',
    );
    if (entry === undefined) throw new Error('fixture entry missing');
    entry.issues = [{ path: 'title', code: 'too_small', message: 'too short' }];
    const bound = bindEntryTruth(payload, 'blog', 'hello-builder');
    expect(bound.outcome === 'truth' && bound.truth.inspectedIssues).toEqual([
      { path: 'title', code: 'too_small', message: 'too short' },
    ]);
  });

  it('answers absent for a collection or entry the payload does not carry', () => {
    const payload = payloadFor(['blog']);
    expect(bindEntryTruth(payload, 'notes', 'scratch')).toEqual({ outcome: 'absent' });
    expect(bindEntryTruth(payload, 'blog', 'no-such-entry')).toEqual({ outcome: 'absent' });
  });

  it('fails closed on payload drift — the structural legs that would tempt a heuristic parse', () => {
    const legs: unknown[] = [
      'not a record',
      {},
      { collections: 'not an array' },
      { collections: [{ name: 'blog' }] }, // no revision/schema/entries
      {
        collections: [
          { name: 'blog', revision: 42, schema: { declared: true, fields: [] }, entries: [] },
        ],
      },
      {
        collections: [
          {
            name: 'blog',
            revision: REVISION,
            schema: { declared: 'yes', fields: [] },
            entries: [],
          },
        ],
      },
      // the entry interior: missing data, non-string body, drifted issues
      {
        collections: [
          {
            name: 'blog',
            revision: REVISION,
            schema: { declared: true, fields: [] },
            entries: [{ id: 'hello-builder', body: 'b', revision: REVISION, issues: null }],
          },
        ],
      },
      {
        collections: [
          {
            name: 'blog',
            revision: REVISION,
            schema: { declared: true, fields: [] },
            entries: [
              {
                id: 'hello-builder',
                data: {},
                body: 7,
                revision: REVISION,
                issues: null,
              },
            ],
          },
        ],
      },
      {
        collections: [
          {
            name: 'blog',
            revision: REVISION,
            schema: { declared: true, fields: [] },
            entries: [
              {
                id: 'hello-builder',
                data: {},
                body: 'b',
                revision: REVISION,
                issues: [{ path: 'title' }],
              },
            ],
          },
        ],
      },
      // the walked tree: an unknown node kind, a drifted enum, a raw node without reason
      {
        collections: [
          {
            name: 'blog',
            revision: REVISION,
            schema: {
              declared: true,
              fields: [{ kind: 'mystery', path: 'x', label: 'x', required: true }],
            },
            entries: [],
          },
        ],
      },
      {
        collections: [
          {
            name: 'blog',
            revision: REVISION,
            schema: {
              declared: true,
              fields: [
                // enum options are strings-or-numbers only: a boolean option is drift
                { kind: 'enum', path: 'x', label: 'x', required: true, options: ['a', true] },
              ],
            },
            entries: [],
          },
        ],
      },
      {
        collections: [
          {
            name: 'blog',
            revision: REVISION,
            schema: {
              declared: true,
              fields: [{ kind: 'raw', path: 'x', label: 'x', required: true }],
            },
            entries: [],
          },
        ],
      },
    ];
    for (const [index, payload] of legs.entries()) {
      const outcome = bindEntryTruth(payload, 'blog', 'hello-builder').outcome;
      expect(outcome, `drift leg ${index}`).toBe('drift');
    }
  });

  it('binds every walked node kind structurally — the frozen trees pass unchanged', () => {
    for (const name of ['blog', 'gallery', 'homepage', 'notes']) {
      const bound = bindEntryTruth(
        payloadFor([name]),
        name,
        collectionsFixture.collections.find((collection) => collection.name === name)?.entries[0]
          ?.id ?? '',
      );
      expect(bound.outcome, name).toBe('truth');
    }
  });
});
