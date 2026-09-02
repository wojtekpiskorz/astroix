import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isEnumeratable,
  isProjectPageRoute,
  toRouteInfos,
  withRenders,
} from '../../astro-project-adapter/routes/routes-payload';
import { at, fixtureRouteMetadata } from './fixture-seams';

/**
 * The typed-pattern projection (#229 focused test): membership, rendering
 * mapping, deep copy, the renders space, and the join semantics — proven
 * against the frozen routes corpus (`e2e/behavior-contracts/inspection/
 * routes.json`, lane B1): the projection over the fixture's seam metadata
 * equals the frozen contract bytes for both the static and the dynamic
 * routes, renders included.
 */

type FixtureEntry = ReturnType<typeof fixtureRouteMetadata>[number];

function metadataEntry(overrides: Partial<FixtureEntry>): FixtureEntry {
  const base = at(fixtureRouteMetadata(), 2); // /blog/[slug]
  return { ...base, ...overrides };
}

describe('membership and projection', () => {
  it('projects project page routes only, in seam order, without renders', () => {
    const infos = toRouteInfos(fixtureRouteMetadata());
    expect(infos.map((info) => info.pattern)).toEqual(['/', '/blog/[slug]', '/blog/[...slug]']);
    expect(infos.every((info) => !('renders' in info))).toBe(true);
  });

  it('drops internal pages, endpoints, and redirects; keeps external pages', () => {
    const metadata = [
      metadataEntry({ pattern: '/a', component: '_server-islands.astro', origin: 'internal' }),
      metadataEntry({ pattern: '/b', component: 'src/pages/b.json', type: 'endpoint' }),
      metadataEntry({ pattern: '/c', component: 'src/pages/c.astro', type: 'redirect' }),
      metadataEntry({ pattern: '/d', component: 'src/pages/d.astro', origin: 'external' }),
      metadataEntry({ pattern: '/e', component: 'src/pages/e.astro' }),
    ];
    expect(metadata.filter(isProjectPageRoute).map((entry) => entry.pattern)).toEqual(['/d', '/e']);
    expect(toRouteInfos(metadata).map((info) => info.pattern)).toEqual(['/d', '/e']);
  });

  it('maps the prerender flag to the rendering mode', () => {
    const infos = toRouteInfos([
      metadataEntry({ pattern: '/static', prerender: true }),
      metadataEntry({ pattern: '/live', prerender: false }),
    ]);
    expect(infos.map((info) => info.rendering)).toEqual(['prerendered', 'on-demand']);
  });

  it('deep-copies the seam segments — mutating metadata after projection changes nothing', () => {
    const metadata = fixtureRouteMetadata();
    const infos = toRouteInfos(metadata);
    const part = at(at(at(metadata, 2).segments, 0), 0) as { content: string };
    part.content = 'mutated';
    expect(infos[1]?.segments[0]?.[0]?.content).toBe('blog');
  });
});

describe('the renders space', () => {
  it('is exactly prerendered single-param project page routes', () => {
    const cases: Array<[Partial<FixtureEntry>, boolean]> = [
      [{ pattern: '/a' }, true], // prerendered single-param page
      [{ pattern: '/b', prerender: false }, false], // on-demand
      [{ pattern: '/c', params: ['x', 'y'] }, false], // multi-param
      [{ pattern: '/d', params: [] }, false], // static
      [{ pattern: '/e', origin: 'internal' }, false], // internal
      [{ pattern: '/f', type: 'endpoint' }, false], // not a page
    ];
    for (const [overrides, expected] of cases) {
      expect(isEnumeratable(metadataEntry(overrides))).toBe(expected);
    }
  });
});

describe('withRenders', () => {
  it('sets renders on enumerated routes — [] is knowably-dead truth', () => {
    const infos = toRouteInfos(fixtureRouteMetadata());
    const joined = withRenders(
      infos,
      new Map([
        ['/blog/[slug]', ['hello-builder']],
        ['/blog/[...slug]', []],
      ]),
    );
    expect(joined.map((info) => info.pattern)).toEqual(['/', '/blog/[slug]', '/blog/[...slug]']);
    expect(joined[0]).not.toHaveProperty('renders');
    expect(joined[1]?.renders).toEqual(['hello-builder']);
    expect(joined[2]?.renders).toEqual([]);
  });

  it('omits renders for routes whose enumeration did not positively succeed', () => {
    const joined = withRenders(toRouteInfos(fixtureRouteMetadata()), new Map());
    expect(joined.every((info) => !('renders' in info))).toBe(true);
  });

  it('never carries renders outside the space, and strips stale renders', () => {
    const infos = toRouteInfos(fixtureRouteMetadata());
    const stale = infos.map((info) =>
      info.pattern === '/' ? { ...info, renders: ['stale'] } : info,
    );
    const joined = withRenders(stale, new Map([['/', ['stale-again']]]));
    expect(joined[0]).not.toHaveProperty('renders');
  });
});

describe('parity with the frozen routes corpus', () => {
  it('projects the fixture seam metadata to the frozen contract payload', async () => {
    const corpus = JSON.parse(
      await readFile(
        join(process.cwd(), 'e2e', 'behavior-contracts', 'inspection', 'routes.json'),
        'utf8',
      ),
    ) as { routes: object[] };
    const renders = new Map<string, readonly string[]>([
      ['/blog/[slug]', ['hello-builder']],
      ['/blog/[...slug]', ['2024/post', '2025/release-notes', 'hello-builder']],
    ]);
    const payload = withRenders(toRouteInfos(fixtureRouteMetadata()), renders);
    // Route order is not contract identity (the corpus schema pins no
    // order) — compare pattern-keyed.
    const byPattern = new Map(payload.map((info) => [info.pattern, info]));
    expect(payload.map((info) => info.pattern).sort()).toEqual(
      corpus.routes.map((route) => (route as { pattern: string }).pattern).sort(),
    );
    expect(byPattern.size).toBe(corpus.routes.length);
    for (const route of corpus.routes) {
      expect(byPattern.get((route as { pattern: string }).pattern)).toEqual(route);
    }
  });
});
