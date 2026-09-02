import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  enumerateRenders,
  extractRenders,
  paramKeyOf,
} from '../../astro-project-adapter/routes/route-enumeration';
import type { RouteMetadataEntry } from '../../astro-project-adapter/routes/route-metadata';
import {
  at,
  entrypointOf,
  FakeRunner,
  type FakeRunnerOptions,
  fixtureRouteMetadata,
  fixtureRouteModules,
} from './fixture-seams';

/**
 * Dynamic-route enumeration (#229 focused test): the managed
 * `getStaticPaths` behavior runs per seam-discovered route through the
 * runner, failures are contained to unknown (a route's renders comes
 * off — never a wrong value), and cancellation is pass-level: an aborted
 * signal rejects the pass with the caller's reason.
 */

const OPTIONS = { projectRoot: '/managed/fixture', waitTimeoutMs: 5_000 };

function runner(options: FakeRunnerOptions = {}): FakeRunner {
  return new FakeRunner(new EventEmitter(), options);
}

function metadataFor(patterns: readonly string[]): RouteMetadataEntry[] {
  return fixtureRouteMetadata().filter((entry) => patterns.includes(entry.pattern));
}

const DYNAMIC = ['/blog/[slug]', '/blog/[...slug]'];
const ALL_BLOG_IDS = ['2024/post', '2025/release-notes', 'hello-builder'];

describe('enumerateRenders', () => {
  it('runs the fixture pages own getStaticPaths and collects corpus renders', async () => {
    const fake = runner({ modules: fixtureRouteModules() });
    const results = await enumerateRenders(fake, fixtureRouteMetadata(), OPTIONS);
    expect(results.get('/blog/[slug]')).toEqual(['hello-builder']);
    expect(results.get('/blog/[...slug]')).toEqual(ALL_BLOG_IDS);
    // Entrypoints are the seam's component fields keyed on the project
    // root — file URLs imported through the runner, nothing guessed from
    // the filesystem, and only the enumeratable routes are loaded.
    expect(fake.importedIds).toEqual([
      entrypointOf('src/pages/blog/[slug].astro'),
      entrypointOf('src/pages/blog/[...slug].astro'),
    ]);
  });

  it('hands getStaticPaths the route pattern and a paginate that fails closed', async () => {
    const seen: Array<{ routePattern?: string; paginateError?: string }> = [];
    const modules = new Map([
      [
        'src/pages/blog/[slug].astro',
        {
          getStaticPaths: async (options: { routePattern: string; paginate: () => never }) => {
            seen.push({ routePattern: options.routePattern });
            try {
              options.paginate();
            } catch (error) {
              seen.push({ paginateError: (error as Error).message });
            }
            return [{ params: { slug: 'x' } }];
          },
        },
      ],
    ]);
    await enumerateRenders(runner({ modules }), metadataFor(DYNAMIC), OPTIONS);
    expect(seen).toEqual([
      { routePattern: '/blog/[slug]' },
      { paginateError: 'paginated routes are outside the supported enumeration contract' },
    ]);
  });

  it('contains every per-route failure to unknown — the other route still enumerates', async () => {
    const failures: ReadonlyArray<[string, object]> = [
      [
        'src/pages/blog/[slug].astro',
        {
          getStaticPaths: () => {
            throw new Error('boom');
          },
        },
      ],
      ['src/pages/blog/[slug].astro', { getStaticPaths: () => 42 }],
      ['src/pages/blog/[slug].astro', {}], // no getStaticPaths export
    ];
    for (const [component, failing] of failures) {
      const modules = new Map(fixtureRouteModules()).set(component, failing);
      const results = await enumerateRenders(runner({ modules }), fixtureRouteMetadata(), OPTIONS);
      expect(results.has('/blog/[slug]')).toBe(false);
      expect(results.get('/blog/[...slug]')).toEqual(ALL_BLOG_IDS);
    }
  });

  it('contains a rejected or hanging entrypoint import via the per-route bound', async () => {
    const rejected = await enumerateRenders(
      runner({
        modules: fixtureRouteModules(),
        failingComponents: ['src/pages/blog/[slug].astro'],
      }),
      fixtureRouteMetadata(),
      OPTIONS,
    );
    expect(rejected.has('/blog/[slug]')).toBe(false);
    const hung = await enumerateRenders(
      runner({
        modules: fixtureRouteModules(),
        hangingComponents: ['src/pages/blog/[slug].astro'],
      }),
      fixtureRouteMetadata(),
      { ...OPTIONS, waitTimeoutMs: 20 },
    );
    expect(hung.has('/blog/[slug]')).toBe(false);
    expect(hung.get('/blog/[...slug]')).toEqual(ALL_BLOG_IDS);
  });

  it('contains a hanging getStaticPaths via the per-route bound', async () => {
    const modules = new Map(fixtureRouteModules()).set('src/pages/blog/[slug].astro', {
      getStaticPaths: () => new Promise<never>(() => {}),
    });
    const results = await enumerateRenders(runner({ modules }), fixtureRouteMetadata(), {
      ...OPTIONS,
      waitTimeoutMs: 20,
    });
    expect(results.has('/blog/[slug]')).toBe(false);
  });

  it('rejects with the signal reason before any work when pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort('stop-it');
    const fake = runner({ modules: fixtureRouteModules() });
    await expect(
      enumerateRenders(fake, fixtureRouteMetadata(), { ...OPTIONS, signal: controller.signal }),
    ).rejects.toBe('stop-it');
    expect(fake.importedIds).toEqual([]);
  });

  it('rejects the whole pass when the signal fires mid-pass — later routes never load', async () => {
    const controller = new AbortController();
    const modules = new Map(fixtureRouteModules()).set('src/pages/blog/[slug].astro', {
      getStaticPaths: async () => {
        controller.abort('lifecycle-stop');
        return [{ params: { slug: 'hello-builder' } }];
      },
    });
    const fake = runner({ modules });
    await expect(
      enumerateRenders(fake, fixtureRouteMetadata(), { ...OPTIONS, signal: controller.signal }),
    ).rejects.toBe('lifecycle-stop');
    expect(fake.importedIds).toEqual([entrypointOf('src/pages/blog/[slug].astro')]);
  });

  it('rejects the pass when the signal fires during a bounded wait, abandoning the work cleanly', async () => {
    const controller = new AbortController();
    const modules = new Map(fixtureRouteModules()).set('src/pages/blog/[slug].astro', {
      getStaticPaths: () =>
        new Promise<never>(() => {
          controller.abort('cancelled-wait');
        }),
    });
    await expect(
      enumerateRenders(runner({ modules }), fixtureRouteMetadata(), {
        ...OPTIONS,
        signal: controller.signal,
      }),
    ).rejects.toBe('cancelled-wait');
  });

  it('rejects a pending wait when the signal fires while it is genuinely in flight', async () => {
    const controller = new AbortController();
    const modules = new Map(fixtureRouteModules()).set('src/pages/blog/[slug].astro', {
      getStaticPaths: () =>
        new Promise<Array<{ params: { slug: string } }>>((resolve) => {
          // The route's static paths are still being computed (a real
          // getCollection read takes time) when the lifecycle cancels.
          setTimeout(() => resolve([{ params: { slug: 'too-late' } }]), 60);
        }),
    });
    setTimeout(() => controller.abort('cancelled-in-flight'), 10);
    const fake = runner({ modules });
    await expect(
      enumerateRenders(fake, fixtureRouteMetadata(), {
        ...OPTIONS,
        signal: controller.signal,
      }),
    ).rejects.toBe('cancelled-in-flight');
    // The abandoned route never settled the pass: the next route was not loaded.
    expect(fake.importedIds).toEqual([entrypointOf('src/pages/blog/[slug].astro')]);
  });
});

describe('render extraction', () => {
  it('keeps first-occurrence order, dedupes, skips non-strings', () => {
    expect(
      extractRenders(
        [
          { params: { slug: 'b' } },
          { params: { slug: 'a' } },
          { params: { slug: 'b' } },
          { params: { slug: 7 } },
          { params: {} },
          { params: null },
          'garbage',
        ],
        'slug',
      ),
    ).toEqual(['b', 'a']);
  });

  it('derives the rest-param key by dropping the dots', () => {
    const metadata = fixtureRouteMetadata();
    expect(paramKeyOf(at(metadata, 3))).toBe('slug'); // the ...slug catch-all
    expect(paramKeyOf(at(metadata, 2))).toBe('slug'); // the segment param
  });
});
