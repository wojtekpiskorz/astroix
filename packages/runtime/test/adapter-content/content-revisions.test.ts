import type { FormFieldNode } from '@wojciechpiskorz/astroix-core';
import { describe, expect, it } from 'vitest';
import type {
  ContentCollectionResult,
  ContentCompatibilityDiagnostic,
} from '../../astro-project-adapter/content/content-result';
import {
  collectionRevision,
  passRevision,
} from '../../astro-project-adapter/content/content-revisions';

/**
 * The content revisions (#228 focused tests): deterministic digests over
 * the typed truth — identical truth ⇒ identical revision across calls,
 * changed truth ⇒ changed revision, at the collection and pass levels —
 * with the content config module's byte baseline as a first-class input
 * (the schema-semantics leg: semantics live in the config's bytes, not
 * in the walked field tree).
 */

const CONFIG_BASELINE = 'config-bytes-digest';

const fields: FormFieldNode[] = [{ kind: 'string', path: 'title', label: 'title', required: true }];

function collection(overrides: Partial<ContentCollectionResult> = {}): ContentCollectionResult {
  return {
    name: 'blog',
    entries: [
      {
        id: 'post',
        filePath: 'src/content/blog/post.md',
        data: { title: 'T' },
        body: 'B',
        revision: 'abc',
        issues: [],
      },
    ],
    schema: { declared: true, fields },
    revision: 'collection-digest',
    ...overrides,
  };
}

function diagnostic(collection = 'api'): ContentCompatibilityDiagnostic {
  return {
    code: 'unknown-loader',
    collection,
    expected: 'the certified glob loader',
    observed: 'object with own properties name, load',
  };
}

describe('collectionRevision', () => {
  it('is deterministic for identical truth and moves with entry, schema, and name truth', () => {
    const base = collection();
    const entry = base.entries[0];
    if (entry === undefined) throw new Error('harness: the base collection needs its entry');
    const first = collectionRevision(CONFIG_BASELINE, base);
    expect(collectionRevision(CONFIG_BASELINE, collection())).toBe(first);

    expect(
      collectionRevision(CONFIG_BASELINE, collection({ entries: [{ ...entry, revision: 'def' }] })),
    ).not.toBe(first);
    expect(
      collectionRevision(CONFIG_BASELINE, collection({ schema: { declared: false, fields: [] } })),
    ).not.toBe(first);
    expect(collectionRevision(CONFIG_BASELINE, collection({ name: 'news' }))).not.toBe(first);
    // The zod projection is deliberately not an input: same bytes, same walk.
    expect(
      collectionRevision(
        CONFIG_BASELINE,
        collection({ entries: [{ ...entry, data: { other: 1 } }] }),
      ),
    ).toBe(first);
  });

  it('moves with the config byte baseline even when the walked truth is identical', () => {
    // The schema-semantics leg: `.min(3)` → `.min(5)`, a changed default,
    // or a rewritten transform body changes the config's bytes — and the
    // served projections and issue records with them — without changing
    // the walked field tree. The config baseline is the input that
    // carries that change into the revision.
    const first = collectionRevision(CONFIG_BASELINE, collection());
    expect(collectionRevision('config-bytes-edited', collection())).not.toBe(first);
    expect(collectionRevision(CONFIG_BASELINE, collection())).toBe(first);
  });
});

describe('passRevision', () => {
  it('is deterministic and moves with collection and diagnostic truth', () => {
    const first = passRevision([collection()], []);
    expect(passRevision([collection()], [])).toBe(first);

    expect(passRevision([collection({ revision: 'moved' })], [])).not.toBe(first);
    expect(passRevision([collection()], [diagnostic()])).not.toBe(first);
    // Diagnostics are ordered input: a different order is different truth.
    expect(passRevision([], [diagnostic('a'), diagnostic('b')])).not.toBe(
      passRevision([], [diagnostic('b'), diagnostic('a')]),
    );
  });
});
