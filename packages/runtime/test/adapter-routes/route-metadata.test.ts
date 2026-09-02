import { describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import { readRouteMetadata } from '../../astro-project-adapter/routes/route-metadata';
import { at, fixtureVirtualRoutesExport, rawRouteData } from './fixture-seams';

/**
 * The route-metadata seam probe (#229 focused test): the reader accepts
 * exactly the certified `virtual:astro:routes` metadata shape and fails
 * closed — `seam-rejected`, seam named, structural observed, never a
 * value dump — on every drift: export shape, per-route metadata shape,
 * unknown literals, and repeated patterns.
 */

const SEAM = 'virtual:astro:routes export';

function expectSeamRejection(probe: () => unknown, expectedFragment: string): AdapterError {
  let rejection: unknown;
  try {
    probe();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(AdapterError);
  const error = rejection as AdapterError;
  expect(error.code).toBe('seam-rejected');
  expect(error.details).toMatchObject({ seam: SEAM, seamClass: 'fail-closed private' });
  expect(error.message).toContain(`seam rejection at ${SEAM}`);
  expect(error.message).toContain(expectedFragment);
  // Output hygiene (ADR-0006 §7): diagnostics never carry route patterns —
  // a pattern has the shape of an absolute path.
  expect(error.message).not.toContain('blog');
  expect(error.message).not.toContain('src/');
  return error;
}

/** A second route in the export carrying `drift` over the certified base shape. */
function exportWithRouteData(drift: Record<string, unknown>): unknown {
  return fixtureVirtualRoutesExport({
    routeData: [rawRouteData({ route: '/ok', component: 'src/pages/ok.astro' }), drift],
  });
}

/** The certified per-route base, ready for a wrong-typed override spread. */
function certifiedRoute(): Record<string, unknown> {
  return rawRouteData({ route: '/x', component: 'src/pages/x.astro', params: ['x'] });
}

describe('readRouteMetadata', () => {
  it('reads the certified fixture export as plain data, live fields dropped', () => {
    const entries = readRouteMetadata(fixtureVirtualRoutesExport());
    expect(entries.map((entry) => entry.pattern)).toEqual([
      '/_server-islands/[name]',
      '/',
      '/blog/[slug]',
      '/blog/[...slug]',
    ]);
    const slug = at(entries, 2);
    expect(slug).toEqual({
      pattern: '/blog/[slug]',
      component: 'src/pages/blog/[slug].astro',
      type: 'page',
      origin: 'project',
      prerender: true,
      params: ['slug'],
      segments: [
        [{ content: 'blog', dynamic: false, spread: false }],
        [{ content: 'slug', dynamic: true, spread: false }],
      ],
    });
    // The live module-graph fields (RegExp pattern, distURL, fallbackRoutes)
    // the certified export also carries are dropped, not held.
    expect(Object.keys(slug).sort()).toEqual([
      'component',
      'origin',
      'params',
      'pattern',
      'prerender',
      'segments',
      'type',
    ]);
  });

  it('deep-copies — later mutation of the export never reaches held entries', () => {
    const exportValue = fixtureVirtualRoutesExport();
    const entries = readRouteMetadata(exportValue);
    const routes = (
      exportValue as {
        routes: { routeData: { segments: Array<Array<{ content: string }>>; params: string[] } }[];
      }
    ).routes;
    const route = at(routes, 2).routeData;
    at(at(route.segments, 0), 0).content = 'mutated';
    route.params = ['hijacked'];
    expect(entries[2]?.segments[0]?.[0]?.content).toBe('blog');
    expect(entries[2]?.params).toEqual(['slug']);
  });

  it('fails closed on export-shape drift', () => {
    expectSeamRejection(() => readRouteMetadata({}), 'an array routes export');
    expectSeamRejection(() => readRouteMetadata({ routes: 'nope' }), 'an array routes export');
    expectSeamRejection(() => readRouteMetadata(null), 'an array routes export');
    expectSeamRejection(
      () => readRouteMetadata({ routes: [{ noRouteData: true }] }),
      'non-empty string routeData.route',
    );
  });

  it('fails closed on per-route metadata drift', () => {
    const cases: ReadonlyArray<[Record<string, unknown>, string]> = [
      [{ route: '' }, 'non-empty string routeData.route'],
      [{ component: 7 }, 'non-empty string routeData.component'],
      [{ type: 'widget' }, 'routeData.type one of'],
      [{ origin: 'alien' }, 'routeData.origin one of'],
      [{ prerender: 'yes' }, 'boolean routeData.prerender'],
      [{ params: ['a', 3] }, 'array of string routeData.params'],
      [{ params: 'slug' }, 'array of string routeData.params'],
    ];
    for (const [drift, expected] of cases) {
      expectSeamRejection(
        () => readRouteMetadata(exportWithRouteData({ ...certifiedRoute(), ...drift })),
        expected,
      );
    }
  });

  it('fails closed on segments drift — array-of-arrays of certified parts', () => {
    const cases: ReadonlyArray<[unknown, string]> = [
      ['nope', 'array routeData.segments'],
      [['nope'], 'segment 0 as an array of parts'],
      [
        [[{ content: 'x', dynamic: true }]],
        'part 0 with string content and boolean dynamic, spread',
      ],
      [
        [[{ content: 7, dynamic: true, spread: false }]],
        'part 0 with string content and boolean dynamic, spread',
      ],
    ];
    for (const [segments, expected] of cases) {
      expectSeamRejection(
        () => readRouteMetadata(exportWithRouteData({ ...certifiedRoute(), segments })),
        expected,
      );
    }
  });

  it('fails closed on repeated patterns — a pattern is route identity', () => {
    const twice = fixtureVirtualRoutesExport({
      routeData: [
        rawRouteData({ route: '/x', component: 'src/pages/x.astro' }),
        rawRouteData({ route: '/x', component: 'src/pages/x-copy.astro' }),
      ],
    });
    const error = expectSeamRejection(() => readRouteMetadata(twice), 'unique patterns');
    expect(error.details).toMatchObject({ observed: '1 repeated pattern' });
  });
});
