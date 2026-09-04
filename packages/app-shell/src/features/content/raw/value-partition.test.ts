import { describe, expect, it } from 'vitest';
import type { FormFieldNode } from '../../../../../core/src/form-tree.ts';
import { inspectionFixture } from '../../../presentation/fixtures.ts';
import { mergeValues, partitionValues } from './value-partition.ts';

/**
 * The partition/merge laws (#252, J2): losslessness over plain value
 * trees — the AC's never-drop property's pure core — plus the frozen
 * walked trees (the B1 content-schemas corpus) as real-world inputs and
 * the property leg over seeded generated trees (deterministic, no
 * property library: a fixed-seed generator runs the same trees every
 * time).
 */

const schemasFixture = inspectionFixture('content-schemas.json');

/** The frozen walked tree for one fixture collection. */
function frozenFields(collection: string): FormFieldNode[] {
  const schema = schemasFixture.schemas.find((entry) => entry.collection === collection);
  if (schema === undefined) throw new Error(`frozen corpus has no walk for ${collection}`);
  return schema.fields as FormFieldNode[];
}

// --- a seeded PRNG (mulberry32): deterministic trees, no new dependency ---

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generates one JSON-plain value tree: leaves, arrays, nested records. */
function generateTree(random: () => number, depth: number): unknown {
  const roll = random();
  if (depth <= 0 || roll < 0.4) {
    const leaf = Math.floor(random() * 4);
    if (leaf === 0) return `v${Math.floor(random() * 1000)}`;
    if (leaf === 1) return Math.floor(random() * 1000);
    if (leaf === 2) return random() < 0.5;
    return null;
  }
  if (roll < 0.6) {
    return Array.from({ length: Math.floor(random() * 3) }, () => generateTree(random, depth - 1));
  }
  const record: Record<string, unknown> = {};
  const keys = Math.floor(random() * 4) + 1;
  for (let index = 0; index < keys; index += 1) {
    record[`k${index}`] = generateTree(random, depth - 1);
  }
  return record;
}

describe('partitionValues / mergeValues', () => {
  it('splits unknown top-level keys from the frozen blog walk and merges back losslessly', () => {
    const fields = frozenFields('blog');
    const values = {
      title: 'Nested post',
      date: '2024-06-01T00:00:00.000Z',
      tags: ['nested'],
      tone: 'bold',
      priority: 0,
      featured: false,
      customFlag: true,
      legacy: { keep: 'me', deep: [1, 2] },
    };
    const split = partitionValues(fields, values);
    expect(split.unknown).toEqual({ customFlag: true, legacy: { keep: 'me', deep: [1, 2] } });
    expect(split.known).toEqual({
      title: 'Nested post',
      date: '2024-06-01T00:00:00.000Z',
      tags: ['nested'],
      tone: 'bold',
      priority: 0,
      featured: false,
    });
    expect(mergeValues(split.known, split.unknown)).toEqual(values);
  });

  it("nests a group's unclaimed inner keys under the group key, at depth", () => {
    const fields = frozenFields('homepage');
    const values = {
      title: 'Astroix fixture',
      lead: 'text',
      cta: { label: 'Get started', href: 'https://astro.build', note: 'extra inner key' },
      orphan: 'top-level unknown',
    };
    const split = partitionValues(fields, values);
    // the group's claimed children ride the known half; the inner
    // unclaimed key rides the unknown half UNDER the group's key
    expect(split.known).toEqual({
      title: 'Astroix fixture',
      lead: 'text',
      cta: { label: 'Get started', href: 'https://astro.build' },
    });
    expect(split.unknown).toEqual({
      cta: { note: 'extra inner key' },
      orphan: 'top-level unknown',
    });
    expect(mergeValues(split.known, split.unknown)).toEqual(values);
  });

  it('treats the schema-less root raw walk as claiming the whole tree', () => {
    const fields = frozenFields('notes');
    // the frozen notes walk is the degraded single root raw node
    expect(fields.length === 1 && fields[0]?.kind === 'raw').toBe(true);
    const values = { kind: 'scratchpad', pinned: true, anything: { nested: [1, 'two'] } };
    const split = partitionValues(fields, values);
    expect(split.known).toBe(values);
    expect(split.unknown).toEqual({});
    expect(mergeValues(split.known, split.unknown)).toBe(values);
  });

  it('carries a non-record value whole on the known side (never invents a shape)', () => {
    const split = partitionValues(frozenFields('blog'), null);
    expect(split.known).toBe(null);
    expect(split.unknown).toEqual({});
  });

  it('loses nothing: merge(partition(v)) deep-equals v for seeded generated trees over every frozen walk', () => {
    const walks = ['blog', 'gallery', 'homepage'] as const;
    // the top-level claimed keys per walk — seeded into the generated
    // trees so the property exercises CLAIMED paths (including nested
    // groups), not only the all-unknown case
    const claimedTop: Record<string, string[]> = {
      blog: ['title', 'tags', 'priority', 'meta'],
      gallery: ['hero', 'alt'],
      homepage: ['title', 'lead', 'cta'],
    };
    const random = rng(20260903);
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const collection = walks[iteration % walks.length] as (typeof walks)[number];
      const fields = frozenFields(collection);
      const values = generateTree(random, 3) as Record<string, unknown>;
      const pool = claimedTop[collection] as string[];
      const claimedKey = pool[Math.floor(random() * pool.length)];
      if (
        claimedKey !== undefined &&
        typeof values === 'object' &&
        values !== null &&
        !Array.isArray(values)
      ) {
        values[claimedKey] = generateTree(random, 2);
      }
      const split = partitionValues(fields, values);
      expect(mergeValues(split.known, split.unknown)).toEqual(values);
    }
  });

  it('drops an unknown key only when the unknown half itself drops it (the section edit is the authority)', () => {
    const fields = frozenFields('blog');
    const known = partitionValues(fields, { title: 't', gone: 1, kept: 2 }).known;
    // the section edited {gone} away and kept {kept}
    expect(mergeValues(known, { kept: 2 })).toEqual({ title: 't', kept: 2 });
  });
});

describe('the walk interop (frozen corpus)', () => {
  it('runs the frozen homepage values through the real walk and the partition without loss', () => {
    // walkSchemaFields over a zod schema needs the schema instance — the
    // frozen corpus carries its OUTPUT; this leg pins the partition
    // against that output directly (the walk itself is core's own
    // tested seam).
    const fields = frozenFields('homepage');
    expect(fields.map((node) => node.path)).toEqual(['title', 'lead', 'image', 'cta']);
    const cta = fields[3];
    expect(cta?.kind === 'group' && cta.children.map((child) => child.path)).toEqual([
      'cta.label',
      'cta.href',
    ]);
  });
});
