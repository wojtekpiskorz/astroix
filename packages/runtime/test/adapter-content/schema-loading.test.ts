import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CollectionDefinitionSeams } from '../../astro-project-adapter/content/content-probes';
import type { ContentCompatibilityDiagnostic } from '../../astro-project-adapter/content/content-result';
import {
  classifyCollectionCategory,
  loadCollectionSchema,
  type SchemaLoadOutcome,
} from '../../astro-project-adapter/content/schema-loading';

/**
 * Certified-category schema loading (#228 focused tests): the
 * loader/type classification and the schema resolution — instance arm,
 * factory arm with the certified `image()` stub built from the
 * project's zod — plus the unsupported loader/factory/shape negatives
 * as structured compatibility diagnostics. The zod instances here are
 * real (the workspace zod, the same library `astro/zod` re-exports);
 * the real-install fidelity is the #225 certification's truth.
 */

const globLoader = { name: 'glob-loader', load: async () => {} };

function certified(overrides: Partial<CollectionDefinitionSeams> = {}): CollectionDefinitionSeams {
  return { type: 'content_layer', loader: globLoader, ...overrides };
}

function expectUnsupported(outcome: SchemaLoadOutcome): ContentCompatibilityDiagnostic {
  if (outcome.outcome !== 'unsupported') throw new Error('expected the unsupported outcome');
  return outcome.diagnostic;
}

describe('classifyCollectionCategory', () => {
  it('certifies the content-layer glob-loader category', () => {
    expect(classifyCollectionCategory('blog', certified()).outcome).toBe('certified');
  });

  it('diagnoses unknown loaders with structured facts, never values', () => {
    const cases: Array<[CollectionDefinitionSeams, string]> = [
      [certified({ loader: { name: 'http-loader', load: async () => {} } }), 'http-loader'],
      [certified({ loader: { name: 'glob-loader' } }), 'glob-loader-without-load'],
      [certified({ loader: async () => {} }), 'a function loader'],
    ];
    for (const [definition, label] of cases) {
      const outcome = classifyCollectionCategory('api', definition);
      expect(outcome.outcome, label).toBe('unsupported');
      if (outcome.outcome !== 'unsupported') throw new Error(label);
      expect(outcome.diagnostic.code).toBe('unknown-loader');
      expect(outcome.diagnostic.collection).toBe('api');
      expect(typeof outcome.diagnostic.expected).toBe('string');
      expect(typeof outcome.diagnostic.observed).toBe('string');
    }
  });

  it('diagnoses legacy and non-content-layer shapes', () => {
    for (const definition of [
      certified({ type: 'content' }),
      certified({ type: 'data' }),
      certified({ type: 'live' }),
      { schema: z.object({}) },
    ]) {
      const outcome = classifyCollectionCategory('legacy', definition);
      expect(outcome.outcome).toBe('unsupported');
      if (outcome.outcome !== 'unsupported') throw new Error('expected the unsupported outcome');
      expect(outcome.diagnostic.code).toBe('unsupported-collection-shape');
    }
  });
});

describe('loadCollectionSchema', () => {
  it('loads the schema-less category: declared false, schema null', async () => {
    const outcome = await loadCollectionSchema('notes', certified(), z);
    expect(outcome.outcome).toBe('loaded');
    if (outcome.outcome !== 'loaded') return;
    expect(outcome.loaded.declared).toBe(false);
    expect(outcome.loaded.schema).toBeNull();
    expect(outcome.loaded.isImage(z.string())).toBe(false);
  });

  it('loads a declared instance schema as-is (the project zod instance)', async () => {
    const schema = z.object({ title: z.string() });
    const outcome = await loadCollectionSchema('blog', certified({ schema }), z);
    expect(outcome.outcome).toBe('loaded');
    if (outcome.outcome !== 'loaded') return;
    expect(outcome.loaded.declared).toBe(true);
    expect(outcome.loaded.schema).toBe(schema);
  });

  it('invokes a schema factory with the certified stub context and marks its image() instances', async () => {
    const seenImages: unknown[] = [];
    const factory = ({ image }: { image(): unknown }) => {
      const hero = image();
      const thumb = image();
      seenImages.push(hero, thumb);
      return z.object({ hero, thumb, alt: z.string() });
    };
    const outcome = await loadCollectionSchema('gallery', certified({ schema: factory }), z);
    expect(outcome.outcome).toBe('loaded');
    if (outcome.outcome !== 'loaded') return;
    expect(outcome.loaded.declared).toBe(true);
    // The stubs are real zod instances from the project namespace, and
    // exactly they — not the project's own schemas — read as images.
    expect(seenImages.length).toBe(2);
    for (const stub of seenImages) expect(outcome.loaded.isImage(stub)).toBe(true);
    expect(outcome.loaded.isImage(z.string())).toBe(false);
    // The stub validates the raw frontmatter shape astro validates: path strings.
    const parsed = await outcome.loaded.schema?.safeParseAsync({
      hero: './pixel.png',
      thumb: './pixel.png',
      alt: 'A',
    });
    expect(parsed?.success).toBe(true);
  });

  it('diagnoses a factory that rejects or returns a non-zod schema', async () => {
    const boom: unknown = certified({
      schema: () => {
        throw new Error('factory boom');
      },
    });
    const rejecting = await loadCollectionSchema('bad', boom as CollectionDefinitionSeams, z);
    expect(expectUnsupported(rejecting)).toMatchObject({
      code: 'unknown-schema-factory',
      collection: 'bad',
      observed: 'a schema factory invocation rejection',
    });

    const returning = await loadCollectionSchema('odd', certified({ schema: () => 42 }), z);
    expect(expectUnsupported(returning).code).toBe('unknown-schema-factory');
  });

  it('diagnoses a declared schema that is not a zod instance', async () => {
    for (const schema of [{ pretend: true }, 'z.object({})', null]) {
      const outcome = await loadCollectionSchema('notzod', certified({ schema }), z);
      expect(expectUnsupported(outcome).code).toBe('unknown-schema-shape');
    }
  });

  it('refuses a factory pass without the zod namespace (an orchestration bug, not a project shape)', async () => {
    await expect(
      loadCollectionSchema('bad', certified({ schema: () => z.object({}) }), null),
    ).rejects.toThrow('the zod namespace was not resolved');
  });
});
