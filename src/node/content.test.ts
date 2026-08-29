import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ZodType, z } from 'astro/zod';
import { afterAll, describe, expect, it } from 'vitest';
import { walkSchemaFields } from '../core/form-tree';
import {
  assembleCollectionsPayload,
  findContentConfigPath,
  type RawContentConfig,
  type RawContentModule,
  resolveCollectionSchema,
  validateDraft,
} from './content';

const scratch = mkdtempSync(join(tmpdir(), 'astroix-content-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('assembleCollectionsPayload', () => {
  it('joins schema presence with core-parsed entries, sorted deterministically', async () => {
    const config: RawContentConfig = {
      collections: {
        blog: { schema: () => 'zod' },
        homepage: {},
      },
    };
    const content: RawContentModule = {
      getCollection: (name) =>
        name === 'blog'
          ? Promise.resolve([
              {
                id: '2025/release-notes',
                filePath: 'src/content/blog/2025/release-notes.md',
                data: { title: 'Release notes' },
                body: 'Second nested fixture post.',
              },
              {
                id: '2024/post',
                filePath: 'src/content/blog/2024/post.md',
                data: { title: 'Nested post' },
                body: 'Nested.',
              },
            ])
          : Promise.resolve([
              {
                id: 'index',
                filePath: 'src/content/homepage/index.md',
                data: { title: 'Astroix fixture' },
                body: null,
                digest: 'abc',
              },
            ]),
    };

    const payload = await assembleCollectionsPayload(config, content);

    expect(payload.map((collection) => collection.name)).toEqual(['blog', 'homepage']);
    expect(payload[0]?.hasSchema).toBe(true);
    expect(payload[0]?.entries.map((entry) => entry.id)).toEqual([
      '2024/post',
      '2025/release-notes',
    ]);
    expect(payload[0]?.entries[0]?.data).toEqual({ title: 'Nested post' });
    expect(payload[1]?.hasSchema).toBe(false);
    expect(payload[1]?.entries[0]).toEqual({
      id: 'index',
      filePath: 'src/content/homepage/index.md',
      data: { title: 'Astroix fixture' },
      body: null,
    });
  });

  it('returns an empty payload without a content config', async () => {
    const content: RawContentModule = { getCollection: () => Promise.resolve([]) };
    expect(await assembleCollectionsPayload(null, content)).toEqual([]);
    expect(await assembleCollectionsPayload({ collections: null }, content)).toEqual([]);
  });

  it('keeps going when a collection has no entries yet (sync race at boot)', async () => {
    const config: RawContentConfig = { collections: { empty: { schema: {} } } };
    const payload = await assembleCollectionsPayload(config, {});
    expect(payload).toEqual([{ name: 'empty', hasSchema: true, entries: [] }]);
  });

  it('orders entries by code unit, not process collation (case-mixed ids)', async () => {
    const config: RawContentConfig = { collections: { blog: {} } };
    const content: RawContentModule = {
      getCollection: () =>
        Promise.resolve([
          { id: 'a-post', data: {}, body: null },
          { id: 'B-post', data: {}, body: null },
        ]),
    };
    const payload = await assembleCollectionsPayload(config, content);
    expect(payload[0]?.entries.map((entry) => entry.id)).toEqual(['B-post', 'a-post']);
  });
});

describe('resolveCollectionSchema', () => {
  it('passes static schemas through untouched', () => {
    const schema = z.object({ title: z.string() });
    const config: RawContentConfig = { collections: { blog: { schema } } };
    expect(resolveCollectionSchema(config, 'blog')).toEqual({ schema, imageStubs: new Set() });
  });

  it('returns null for unknown collections', () => {
    expect(resolveCollectionSchema({ collections: {} }, 'missing')).toBeNull();
    expect(resolveCollectionSchema(null, 'missing')).toBeNull();
  });

  it('calls function schemas with image stubs the walker recognizes by membership', () => {
    const config: RawContentConfig = {
      collections: {
        gallery: {
          schema: ({ image }: { image: () => ZodType }) =>
            z.object({ hero: image(), badge: image().optional(), alt: z.string() }),
        },
      },
    };
    const resolved = resolveCollectionSchema(config, 'gallery');
    if (resolved === null) throw new Error('unresolved');
    const fields = walkSchemaFields(resolved.schema, {
      isImage: (schema) => resolved.imageStubs.has(schema as object),
    });
    expect(fields.find((field) => field.path === 'hero')).toMatchObject({
      kind: 'image',
      required: true,
    });
    expect(fields.find((field) => field.path === 'badge')).toMatchObject({
      kind: 'image',
      required: false,
    });
    expect(fields.find((field) => field.path === 'alt')).toMatchObject({ kind: 'string' });
  });

  it('degrades a throwing schema function to the raw-field root', () => {
    const config: RawContentConfig = {
      collections: {
        broken: {
          schema: () => {
            throw new Error('boom');
          },
        },
      },
    };
    const resolved = resolveCollectionSchema(config, 'broken');
    expect(resolved?.schema).toBeNull();
    expect(walkSchemaFields(resolved?.schema)).toEqual([
      expect.objectContaining({ kind: 'raw', path: '' }),
    ]);
  });
});

describe('validateDraft', () => {
  it('projects zod issues onto dotted paths, indexes included', async () => {
    const schema = z.object({
      title: z.string().min(3),
      tags: z.array(z.string()),
    });
    const issues = await validateDraft(schema, { title: 'ab', tags: ['ok', 42] });
    expect(issues).toEqual([
      expect.objectContaining({ path: 'title', code: 'too_small' }),
      expect.objectContaining({ path: 'tags.1', code: 'invalid_type' }),
    ]);
  });

  it('validates clean on a passing draft', async () => {
    const issues = await validateDraft(z.object({ title: z.string() }), { title: 'Fine' });
    expect(issues).toEqual([]);
  });

  it('treats schema-less collections as clean (nothing to validate)', async () => {
    expect(await validateDraft(null, { anything: true })).toEqual([]);
    expect(await validateDraft(undefined, {})).toEqual([]);
  });

  it('never issues on image stubs — the draft carries zod output (metadata objects)', async () => {
    const config: RawContentConfig = {
      collections: {
        gallery: {
          schema: ({ image }: { image: () => ZodType }) => z.object({ hero: image().optional() }),
        },
      },
    };
    const resolved = resolveCollectionSchema(config, 'gallery');
    const issues = await validateDraft(resolved?.schema, {
      hero: { src: '/img.png', width: 640, height: 480, ASTRO_ASSET: '/tmp/x' },
    });
    expect(issues).toEqual([]);
  });
});

describe('findContentConfigPath', () => {
  it('mirrors core search order: src/content.config.* before legacy src/content/config.*', () => {
    writeFileSync(join(scratch, 'content.config.ts'), 'export const collections = {};');
    mkdirSync(join(scratch, 'content'), { recursive: true });
    writeFileSync(join(scratch, 'content', 'config.mjs'), 'export const collections = {};');
    expect(findContentConfigPath(scratch)).toBe(join(scratch, 'content.config.ts'));
  });

  it('returns null when the project defines no content config', () => {
    expect(findContentConfigPath(join(scratch, 'missing'))).toBeNull();
  });
});
