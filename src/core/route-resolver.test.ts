import { describe, expect, it } from 'vitest';
import type { RouteInfo, RouteSegmentPart } from './route-resolver';
import { hasCandidateRoutes, pickNavigableCandidate, resolveActiveEntry } from './route-resolver';

const staticPart = (content: string): RouteSegmentPart => ({
  content,
  dynamic: false,
  spread: false,
});

/** Test-side projection of an `astro:routes:resolved` page route from its pattern string. */
function page(pattern: string): RouteInfo {
  const params: string[] = [];
  const segments = pattern
    .split('/')
    .filter((part) => part !== '')
    .map((text) => partFor(text, params));
  return { pattern, segments, params };
}

function partFor(text: string, params: string[]): RouteSegmentPart[] {
  const single = /^\[(\.\.\.)?(.+)\]$/.exec(text);
  if (single === null) {
    if (text.includes('[') || text.includes(']')) {
      throw new Error(
        `test builder: unsupported segment "${text}" — build the RouteInfo literally`,
      );
    }
    return [staticPart(text)];
  }
  const name = single[2] ?? text;
  params.push(single[1] ? `...${name}` : name);
  return [{ content: name, dynamic: true, spread: single[1] !== undefined }];
}

function routes(...patterns: string[]): RouteInfo[] {
  return patterns.map(page);
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
    const embedded: RouteInfo = {
      pattern: '/pages/v-[id]',
      segments: [
        [staticPart('pages')],
        [staticPart('v-'), { content: 'id', dynamic: true, spread: false }],
      ],
      params: ['id'],
    };
    expect(resolveActiveEntry([embedded], '/pages/v-5', { pages: ['5'] })).toBeNull();
  });

  it('segments Astro never emits (empty parts) are ignored, valid routes still resolve', () => {
    const empty: RouteInfo = { pattern: '/weird', segments: [[]], params: [] };
    const hit = resolveActiveEntry([empty, ...routes('/blog/[slug]')], '/blog/hello', {
      blog: ['hello'],
    });
    expect(hit).toEqual({ collection: 'blog', entryId: 'hello' });
  });

  it('a mid-pattern rest stays silent — its capture would not be the entry id', () => {
    // src/pages/[...slug]/edit.astro: astro serves /foo/edit with slug = 'foo',
    // but slicing to the URL end would capture 'foo/edit' — a wrong pick.
    const midRest: RouteInfo = {
      pattern: '/[...slug]/edit',
      segments: [[{ content: 'slug', dynamic: true, spread: true }], [staticPart('edit')]],
      params: ['...slug'],
    };
    expect(resolveActiveEntry([midRest], '/foo/edit', { pages: ['foo/edit'] })).toBeNull();
    expect(resolveActiveEntry([midRest], '/foo/edit', { pages: ['foo'] })).toBeNull();
    expect(pickNavigableCandidate('foo/edit', [midRest], { pages: ['foo/edit'] })).toBeNull();
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

describe('pickNavigableCandidate — reverse (entry → canvas URL, #109)', () => {
  it('a single candidate returns its URL — the nested-id catch-all case unchanged', () => {
    expect(
      pickNavigableCandidate('2024/post', routes('/blog/[slug]', '/blog/[...slug]'), {
        blog: ['2024/post'],
      }),
    ).toBe('/blog/2024/post');
  });

  it('a single-segment id fills a catch-all alone when no segment-param route exists', () => {
    expect(
      pickNavigableCandidate('hello', routes('/blog/[...slug]'), {
        blog: ['hello'],
      }),
    ).toBe('/blog/hello');
  });

  it('a root-level catch-all has no static prefix', () => {
    expect(
      pickNavigableCandidate('blog/hello', routes('/[...slug]'), {
        pages: ['blog/hello'],
      }),
    ).toBe('/blog/hello');
  });

  it('skips static and multi-param routes', () => {
    expect(
      pickNavigableCandidate(
        'hello',
        routes('/', '/about', '/[lang]/blog/[slug]', '/blog/[slug]'),
        {
          blog: ['hello'],
        },
      ),
    ).toBe('/blog/hello');
  });

  it('encodes the id into the URL', () => {
    expect(
      pickNavigableCandidate('café', routes('/blog/[slug]'), {
        blog: ['café'],
      }),
    ).toBe('/blog/caf%C3%A9');
  });

  it('a same-entry plurality navigates — the segment param beats the catch-all regardless of input order', () => {
    expect(
      pickNavigableCandidate('hello', routes('/[...slug]', '/blog/[slug]'), {
        blog: ['hello'],
      }),
    ).toBe('/blog/hello');
  });

  it('the fixture shape — segment param and catch-all spelling one URL — navigates it', () => {
    expect(
      pickNavigableCandidate('hello-builder', routes('/blog/[slug]', '/blog/[...slug]'), {
        blog: ['hello-builder'],
      }),
    ).toBe('/blog/hello-builder');
  });

  it('among segment params the shallower pattern wins', () => {
    expect(
      pickNavigableCandidate('hello', routes('/a/b/[slug]', '/a/[slug]'), {
        blog: ['hello'],
      }),
    ).toBe('/a/hello');
  });

  it('equal specificity keeps route input order', () => {
    expect(
      pickNavigableCandidate('hello', routes('/x/[slug]', '/y/[slug]'), {
        blog: ['hello'],
      }),
    ).toBe('/x/hello');
    expect(
      pickNavigableCandidate('hello', routes('/y/[slug]', '/x/[slug]'), {
        blog: ['hello'],
      }),
    ).toBe('/y/hello');
  });

  it('a plurality leading to different entries stays silent', () => {
    // /blog/hello forward-resolves to two entries (blog:hello through
    // [slug], pages:blog/hello through the root catch-all) — ambiguity
    expect(
      pickNavigableCandidate('hello', routes('/blog/[slug]', '/[...slug]'), {
        blog: ['hello'],
        pages: ['blog/hello'],
      }),
    ).toBeNull();
  });

  it('an id held by two collections stays silent', () => {
    expect(
      pickNavigableCandidate('hello', routes('/blog/[slug]'), {
        blog: ['hello'],
        news: ['hello'],
      }),
    ).toBeNull();
  });

  it('a static page keeps its candidate filtered out — the surviving candidate navigates', () => {
    expect(
      pickNavigableCandidate('hello', routes('/blog/hello', '/blog/[slug]', '/other/[slug]'), {
        blog: ['hello'],
      }),
    ).toBe('/other/hello');
  });

  it('a candidate URL fully shadowed by a static page leaves nothing to navigate', () => {
    expect(
      pickNavigableCandidate('hello', routes('/blog/hello', '/blog/[slug]'), {
        blog: ['hello'],
      }),
    ).toBeNull();
  });

  it('a dangling id (held by no collection) stays silent — its candidate would forward-resolve to another entry', () => {
    // /blog/hello captures 'hello' via [slug] (unheld) and 'blog/hello' via
    // the root catch-all (held by pages) — a single hit, but the wrong entry
    expect(
      pickNavigableCandidate('hello', routes('/blog/[slug]', '/[...slug]'), {
        pages: ['blog/hello'],
      }),
    ).toBeNull();
  });

  it('an empty id yields no candidates', () => {
    expect(
      pickNavigableCandidate('', routes('/blog/[slug]', '/blog/[...slug]'), {
        blog: ['hello'],
      }),
    ).toBeNull();
  });

  it('no candidates — null', () => {
    expect(
      pickNavigableCandidate('2024/post', routes('/blog/[slug]'), { blog: ['2024/post'] }),
    ).toBeNull();
  });
});

describe('hasCandidateRoutes — the unrouted marker predicate (#111)', () => {
  it('a fillable single-param pattern counts, regardless of plurality', () => {
    expect(hasCandidateRoutes('hello', routes('/blog/[slug]', '/blog/[...slug]'))).toBe(true);
    expect(hasCandidateRoutes('2024/post', routes('/blog/[...slug]'))).toBe(true);
  });

  it('nothing fills the id — false (static routes render no candidate)', () => {
    expect(hasCandidateRoutes('hello', routes('/', '/about'))).toBe(false);
    expect(hasCandidateRoutes('2024/post', routes('/blog/[slug]'))).toBe(false);
  });

  it('an empty route set is unrouted', () => {
    expect(hasCandidateRoutes('hello', [])).toBe(false);
  });
});
