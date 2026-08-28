import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntegrationResolvedRoute } from 'astro';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assembleCollectionsPayload,
  findContentConfigPath,
  type RawContentConfig,
  type RawContentModule,
  toRouteInfos,
} from './content';

const scratch = mkdtempSync(join(tmpdir(), 'astroix-content-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function hookRoute(overrides: Record<string, unknown>): IntegrationResolvedRoute {
  return {
    pattern: '/blog/[...slug]',
    segments: [
      [{ content: 'blog', dynamic: false, spread: false }],
      [{ content: '...slug', dynamic: true, spread: true }],
    ],
    params: ['...slug'],
    type: 'page',
    ...overrides,
  } as unknown as IntegrationResolvedRoute;
}

describe('toRouteInfos', () => {
  it('projects page routes onto RouteInfo with Astro segments, deep-copied', () => {
    const segments = [[{ content: 'blog', dynamic: false, spread: false }]];
    const [info] = toRouteInfos([hookRoute({ segments })]);
    expect(info).toEqual({
      pattern: '/blog/[...slug]',
      segments,
      params: ['...slug'],
    });
    expect(info?.segments).not.toBe(segments);
    expect(info?.segments[0]).not.toBe(segments[0]);
  });

  it('drops endpoint, redirect and fallback routes (resolver contract, #77 ruling)', () => {
    const routes = [
      hookRoute({ type: 'page' }),
      hookRoute({ type: 'endpoint', pattern: '/api' }),
      hookRoute({ type: 'redirect', pattern: '/old' }),
      hookRoute({ type: 'fallback', pattern: '/404' }),
    ];
    expect(toRouteInfos(routes).map((info) => info.pattern)).toEqual(['/blog/[...slug]']);
  });
});

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
