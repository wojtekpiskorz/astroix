import { describe, expect, it } from 'vitest';
import type { RouteInfo } from './route-resolver';
import { candidateRoutes, resolveActiveEntry } from './route-resolver';

function routes(...patterns: string[]): RouteInfo[] {
  return patterns.map((pattern) => ({ pattern }));
}

describe('resolveActiveEntry — forward (canvas URL → entry)', () => {
  it('resolves a single-param route hit from the full canvas URL (query string ignored)', () => {
    const hit = resolveActiveEntry(
      routes('/', '/about', '/blog/[slug]'),
      'http://localhost:4314/blog/hello?builder=0',
      { blog: ['hello', 'world'] },
    );
    expect(hit).toEqual({ collection: 'blog', entryId: 'hello' });
  });

  it('accepts a bare pathname', () => {
    expect(resolveActiveEntry(routes('/blog/[slug]'), '/blog/hello', { blog: ['hello'] })).toEqual({
      collection: 'blog',
      entryId: 'hello',
    });
  });

  it('ignores a trailing slash', () => {
    expect(resolveActiveEntry(routes('/blog/[slug]'), '/blog/hello/', { blog: ['hello'] })).toEqual(
      {
        collection: 'blog',
        entryId: 'hello',
      },
    );
  });

  it('resolves a nested-path id through a rest param (glob-loader ids are slugified paths)', () => {
    const hit = resolveActiveEntry(routes('/blog/[...slug]'), '/blog/2024/post', {
      blog: ['2024/post'],
    });
    expect(hit).toEqual({ collection: 'blog', entryId: '2024/post' });
  });

  it('rest param captures at least one segment — /blog alone hits nothing', () => {
    expect(resolveActiveEntry(routes('/blog/[...slug]'), '/blog', { blog: ['blog'] })).toBeNull();
  });

  it('the same entry id in two collections is ambiguous — no hit', () => {
    const hit = resolveActiveEntry(routes('/blog/[slug]'), '/blog/hello', {
      blog: ['hello'],
      news: ['hello'],
    });
    expect(hit).toBeNull();
  });

  it('overlapping patterns resolving to different entries are ambiguous — no hit', () => {
    const hit = resolveActiveEntry(routes('/blog/[slug]', '/[...slug]'), '/blog/hello', {
      blog: ['hello'],
      pages: ['blog/hello'],
    });
    expect(hit).toBeNull();
  });

  it('overlapping patterns resolving to the same entry stay a single hit', () => {
    const hit = resolveActiveEntry(routes('/blog/[slug]', '/blog/[...slug]'), '/blog/hello', {
      blog: ['hello'],
    });
    expect(hit).toEqual({ collection: 'blog', entryId: 'hello' });
  });

  it('non-collection routes never resolve: static pages, root, unknown paths', () => {
    const all = routes('/', '/about', '/blog/[slug]');
    expect(resolveActiveEntry(all, '/about', { blog: ['about'] })).toBeNull();
    expect(resolveActiveEntry(all, '/', { blog: ['hello'] })).toBeNull();
    expect(resolveActiveEntry(all, '/nope', { blog: ['hello'] })).toBeNull();
  });

  it('a static page shadowing the dynamic route stays silent — Astro serves static first', () => {
    const hit = resolveActiveEntry(routes('/blog/hello', '/blog/[slug]'), '/blog/hello', {
      blog: ['hello'],
    });
    expect(hit).toBeNull();
  });

  it('multi-param patterns stay silent — the id cannot be isolated', () => {
    const hit = resolveActiveEntry(routes('/[lang]/blog/[slug]'), '/en/blog/hello', {
      lang: ['en'],
      blog: ['hello'],
    });
    expect(hit).toBeNull();
  });

  it('embedded params are not extracted — /pages/v-[id] stays silent', () => {
    expect(resolveActiveEntry(routes('/pages/v-[id]'), '/pages/v-5', { pages: ['5'] })).toBeNull();
  });

  it('malformed patterns are ignored, valid ones still resolve', () => {
    const hit = resolveActiveEntry(routes('[]', '/[...a]/more', '/blog/[slug]'), '/blog/hello', {
      blog: ['hello'],
    });
    expect(hit).toEqual({ collection: 'blog', entryId: 'hello' });
  });

  it('percent-decoded segments match unicode entry ids', () => {
    const hit = resolveActiveEntry(routes('/blog/[slug]'), '/blog/caf%C3%A9', {
      blog: ['café'],
    });
    expect(hit).toEqual({ collection: 'blog', entryId: 'café' });
  });

  it('undecodable segments compare raw rather than throw', () => {
    const hit = resolveActiveEntry(routes('/blog/[slug]'), '/blog/%E0%A4%A', {
      blog: ['%E0%A4%A'],
    });
    expect(hit).toEqual({ collection: 'blog', entryId: '%E0%A4%A' });
  });
});

describe('candidateRoutes — reverse (entry → canvas routes)', () => {
  it('builds the single-param route URL for a single-segment id', () => {
    expect(candidateRoutes('hello', routes('/blog/[slug]'))).toEqual([
      { pattern: '/blog/[slug]', url: '/blog/hello' },
    ]);
  });

  it('builds the catch-all URL for a nested-path id', () => {
    expect(candidateRoutes('2024/post', routes('/blog/[...slug]'))).toEqual([
      { pattern: '/blog/[...slug]', url: '/blog/2024/post' },
    ]);
  });

  it('a single-segment id also fits a catch-all', () => {
    expect(candidateRoutes('hello', routes('/blog/[...slug]'))).toEqual([
      { pattern: '/blog/[...slug]', url: '/blog/hello' },
    ]);
  });

  it('a root-level catch-all has no static prefix', () => {
    expect(candidateRoutes('blog/hello', routes('/[...slug]'))).toEqual([
      { pattern: '/[...slug]', url: '/blog/hello' },
    ]);
  });

  it('a nested id cannot fill a single-param route — no candidate', () => {
    expect(candidateRoutes('2024/post', routes('/blog/[slug]'))).toEqual([]);
  });

  it('skips static and multi-param routes', () => {
    const candidates = candidateRoutes(
      'hello',
      routes('/', '/about', '/[lang]/blog/[slug]', '/blog/[slug]'),
    );
    expect(candidates).toEqual([{ pattern: '/blog/[slug]', url: '/blog/hello' }]);
  });

  it('returns every plausible route in input order — plurality is the caller ambiguity call', () => {
    const candidates = candidateRoutes('hello', routes('/blog/[slug]', '/posts/[slug]'));
    expect(candidates).toEqual([
      { pattern: '/blog/[slug]', url: '/blog/hello' },
      { pattern: '/posts/[slug]', url: '/posts/hello' },
    ]);
  });

  it('encodes the id into the URL', () => {
    expect(candidateRoutes('café', routes('/blog/[slug]'))).toEqual([
      { pattern: '/blog/[slug]', url: '/blog/caf%C3%A9' },
    ]);
  });

  it('an empty id yields no candidates', () => {
    expect(candidateRoutes('', routes('/blog/[slug]', '/blog/[...slug]'))).toEqual([]);
  });
});
