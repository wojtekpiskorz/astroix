import { type ZodType, z } from 'astro/zod';
import { describe, expect, it } from 'vitest';
import { type FormFieldNode, type WalkOptions, walkSchemaFields } from './form-tree';

/** The walker's contract test — behavior (the output field tree), never def internals. */
function walk(schema: unknown, options?: WalkOptions): FormFieldNode[] {
  return walkSchemaFields(schema, options ?? {});
}

/** Node lookup by dotted path (top-level object children only in these fixtures). */
function nodeAt(fields: FormFieldNode[], path: string): FormFieldNode {
  const found = fields.find((field) => field.path === path);
  if (found === undefined) throw new Error(`no node at ${path}: ${JSON.stringify(fields)}`);
  return found;
}

describe('walkSchemaFields — leaf mapping', () => {
  it('maps string, number, boolean and enum to their widgets', () => {
    const fields = walk(
      z.object({
        title: z.string(),
        priority: z.number(),
        featured: z.boolean(),
        tone: z.enum(['bold', 'calm']),
      }),
    );
    expect(nodeAt(fields, 'title')).toMatchObject({ kind: 'string', required: true });
    expect(nodeAt(fields, 'priority')).toMatchObject({ kind: 'number', required: true });
    expect(nodeAt(fields, 'featured')).toMatchObject({ kind: 'boolean', required: true });
    expect(nodeAt(fields, 'tone')).toMatchObject({ kind: 'enum', options: ['bold', 'calm'] });
  });

  it('carries nativeEnum options and coerced numbers', () => {
    const fields = walk(
      z.object({ level: z.nativeEnum({ Low: 1, High: 2 }), width: z.coerce.number() }),
    );
    expect(nodeAt(fields, 'level')).toMatchObject({ kind: 'enum', options: [1, 2] });
    expect(nodeAt(fields, 'width')).toMatchObject({ kind: 'number' });
  });

  it('numbers stay widgets with checks attached (min/max ride safeParse)', () => {
    const fields = walk(z.object({ title: z.string().min(3), count: z.number().int().max(10) }));
    expect(nodeAt(fields, 'title')).toMatchObject({ kind: 'string' });
    expect(nodeAt(fields, 'count')).toMatchObject({ kind: 'number' });
  });
});

describe('walkSchemaFields — wrappers', () => {
  it('peels optional and default, recording required=false and the initial value', () => {
    const fields = walk(
      z.object({
        lead: z.string().optional(),
        tone: z.enum(['bold', 'calm']).default('bold'),
        tags: z.array(z.string()).default([]),
        href: z.string().nullable(),
      }),
    );
    expect(nodeAt(fields, 'lead')).toMatchObject({ kind: 'string', required: false });
    expect(nodeAt(fields, 'lead')).not.toHaveProperty('initial');
    expect(nodeAt(fields, 'tone')).toMatchObject({
      kind: 'enum',
      required: false,
      initial: 'bold',
    });
    expect(nodeAt(fields, 'tags')).toMatchObject({ kind: 'array', required: false, initial: [] });
    expect(nodeAt(fields, 'href')).toMatchObject({ kind: 'string', required: false });
  });

  it('peels stacked wrappers (optional then default) without losing the inner mapping', () => {
    const fields = walk(z.object({ tone: z.string().optional().default('calm') }));
    expect(nodeAt(fields, 'tone')).toMatchObject({
      kind: 'string',
      required: false,
      initial: 'calm',
    });
  });
});

describe('walkSchemaFields — structure', () => {
  it('maps nested objects to group fieldsets with dotted paths', () => {
    const fields = walk(
      z.object({
        cta: z
          .object({
            label: z.string(),
            href: z.string(),
          })
          .optional(),
      }),
    );
    const cta = nodeAt(fields, 'cta');
    expect(cta).toMatchObject({ kind: 'group', required: false });
    if (cta.kind !== 'group') throw new Error('unreachable');
    expect(cta.children.map((child) => child.path)).toEqual(['cta.label', 'cta.href']);
    expect(cta.children.every((child) => child.required)).toBe(true);
  });

  it('maps arrays of primitives to repeatable rows and arrays of anything else to raw', () => {
    const fields = walk(
      z.object({
        tags: z.array(z.string()),
        scores: z.array(z.coerce.number()).optional(),
        matrix: z.array(z.object({ x: z.string() })),
        mixed: z.array(z.union([z.string(), z.number()])),
      }),
    );
    expect(nodeAt(fields, 'tags')).toMatchObject({ kind: 'array', item: { kind: 'string' } });
    expect(nodeAt(fields, 'scores')).toMatchObject({
      kind: 'array',
      item: { kind: 'number' },
      required: false,
    });
    expect(nodeAt(fields, 'matrix')).toMatchObject({ kind: 'raw', reason: 'array<object>' });
    expect(nodeAt(fields, 'mixed')).toMatchObject({ kind: 'raw', reason: 'array<union>' });
  });
});

describe('walkSchemaFields — the raw-field fallback', () => {
  it('maps every unsupported node kind to a raw field carrying its reason', () => {
    const fields = walk(
      z.object({
        aside: z.union([z.string(), z.number()]).optional(),
        published: z.coerce.date(),
        registry: z.record(z.string(), z.string()),
        slug: z.literal('fixed'),
        shout: z.string().transform((value) => value.toUpperCase()),
        anything: z.any(),
      }),
    );
    expect(nodeAt(fields, 'aside')).toMatchObject({
      kind: 'raw',
      reason: 'union',
      required: false,
    });
    expect(nodeAt(fields, 'published')).toMatchObject({ kind: 'raw', reason: 'date' });
    expect(nodeAt(fields, 'registry')).toMatchObject({ kind: 'raw', reason: 'record' });
    expect(nodeAt(fields, 'slug')).toMatchObject({ kind: 'raw', reason: 'literal' });
    expect(nodeAt(fields, 'shout')).toMatchObject({ kind: 'raw', reason: 'pipe' });
    expect(nodeAt(fields, 'anything')).toMatchObject({ kind: 'raw', reason: 'any' });
  });

  it('degrades a non-object root (or no schema at all) to one root raw field', () => {
    expect(walk(z.union([z.string(), z.number()]))).toEqual([
      { kind: 'raw', path: '', label: 'frontmatter', required: true, reason: 'union' },
    ]);
    expect(walk(undefined)).toEqual([
      { kind: 'raw', path: '', label: 'frontmatter', required: true, reason: 'unwalkable' },
    ]);
    expect(walk(null)).toEqual([
      { kind: 'raw', path: '', label: 'frontmatter', required: true, reason: 'unwalkable' },
    ]);
  });
});

describe('walkSchemaFields — image detection', () => {
  it('marks stub instances through the injected predicate, through wrappers', () => {
    // The server substitutes its own image() stubs and recognizes them by
    // membership — here the fixture plays the resolver with a plain set.
    const stubs = new Set<unknown>();
    const image = (): ZodType => {
      const stub = z.any();
      stubs.add(stub);
      return stub;
    };
    const fields = walk(
      z.object({
        hero: image(),
        badge: image().optional(),
        gallery: z.array(image()),
      }),
      { isImage: (schema) => stubs.has(schema) },
    );
    expect(nodeAt(fields, 'hero')).toMatchObject({ kind: 'image', required: true });
    expect(nodeAt(fields, 'badge')).toMatchObject({ kind: 'image', required: false });
    // arrays admit only primitive rows — an image row falls to the raw field
    expect(nodeAt(fields, 'gallery')).toMatchObject({ kind: 'raw', reason: 'array<any>' });
  });

  it('yields no image nodes without the predicate', () => {
    const fields = walk(z.object({ hero: z.any() }));
    expect(nodeAt(fields, 'hero').kind).toBe('raw');
  });
});

describe('walkSchemaFields — labels and order', () => {
  it('labels nodes by their path segment and keeps schema declaration order', () => {
    const fields = walk(
      z.object({
        title: z.string(),
        cta: z.object({ label: z.string(), href: z.string().optional() }),
      }),
    );
    expect(fields.map((field) => field.label)).toEqual(['title', 'cta']);
    const cta = nodeAt(fields, 'cta');
    if (cta.kind !== 'group') throw new Error('unreachable');
    expect(cta.children.map((child) => [child.label, child.required])).toEqual([
      ['label', true],
      ['href', false],
    ]);
  });
});
