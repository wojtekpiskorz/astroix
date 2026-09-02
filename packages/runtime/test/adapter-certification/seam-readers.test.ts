import { describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import {
  readAstroCssUtil,
  readClientEnvironment,
  readDevCssEntries,
  readGetViteConfig,
  readRouteEntries,
  readRunnerContract,
  readSsrEnvironment,
  readTransformedModule,
  readViteClientCss,
  readViteRuntime,
} from '../../astro-project-adapter/seam-readers';

/**
 * The fail-closed seam probes (#225 focused test, ported from the #206
 * negative matrix): every reader accepts exactly the certified shape and
 * throws a `seam-rejected` AdapterError naming the seam, its class, the
 * expected shape, and a structural observed description — never a guess,
 * never a value dump. Unknown private shapes are compatibility events.
 */

function expectSeamRejection(probe: () => unknown, seam: string, seamClass: string): void {
  let rejection: unknown;
  try {
    probe();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(AdapterError);
  const error = rejection as AdapterError;
  expect(error.code).toBe('seam-rejected');
  expect(error.details).toMatchObject({ seam, seamClass });
  expect(error.message).toContain(`seam rejection at ${seam}`);
}

describe('readGetViteConfig (public seam)', () => {
  it('accepts a function getViteConfig export', () => {
    expect(typeof readGetViteConfig({ getViteConfig: () => async () => ({}) })).toBe('function');
  });

  it('fails closed when astro/config changes shape', () => {
    expectSeamRejection(
      () => readGetViteConfig({ loadConfig: () => {} }),
      'astro/config#getViteConfig()',
      'public',
    );
    expectSeamRejection(() => readGetViteConfig(null), 'astro/config#getViteConfig()', 'public');
  });
});

describe('readViteRuntime (public + certified exact-pair seams)', () => {
  it('accepts both root exports', () => {
    const seams = readViteRuntime({
      createServer: async () => ({}),
      createServerModuleRunner: () => ({}),
    });
    expect(typeof seams.createServer).toBe('function');
    expect(typeof seams.createServerModuleRunner).toBe('function');
  });

  it('fails closed without createServer', () => {
    expectSeamRejection(
      () => readViteRuntime({ createServerModuleRunner: () => ({}) }),
      'vite root export createServer()',
      'public',
    );
  });

  it('fails closed without the experimental runner factory', () => {
    expectSeamRejection(
      () => readViteRuntime({ createServer: async () => ({}) }),
      'vite root export createServerModuleRunner()',
      'certified exact-pair',
    );
  });
});

describe('readAstroCssUtil (fail-closed private seam)', () => {
  it('accepts the internal getDevCSSModuleName export', () => {
    expect(
      readAstroCssUtil({ getDevCSSModuleName: (id: string) => `virtual:astro:dev-css:${id}` })('c'),
    ).toBe('virtual:astro:dev-css:c');
  });

  it('fails closed when the internal module drifts', () => {
    expectSeamRejection(
      () => readAstroCssUtil({ getDevCssModuleNames: () => [] }),
      'astro internal dist/vite-plugin-css/util.js#getDevCSSModuleName',
      'fail-closed private',
    );
  });
});

describe('readRunnerContract (public seam)', () => {
  const runner = {
    import: async () => ({}),
    close: async () => {},
    isClosed: () => true,
  };

  it('accepts the runner lifecycle surface', () => {
    expect(readRunnerContract(runner).isClosed()).toBe(true);
  });

  it('fails closed without close or isClosed', () => {
    expectSeamRejection(
      () => readRunnerContract({ import: async () => ({}) }),
      'vite module runner lifecycle (import, close, isClosed)',
      'public',
    );
    expectSeamRejection(
      () => readRunnerContract(null),
      'vite module runner lifecycle (import, close, isClosed)',
      'public',
    );
  });
});

describe('readSsrEnvironment (fail-closed private seams)', () => {
  const emitter = { listenerCount: () => 0 };
  const environment = {
    moduleGraph: { getModuleById: () => null, getModuleByUrl: () => null },
    pluginContainer: { resolveId: async () => null },
    hot: { api: { outsideEmitter: emitter } },
  };

  it('accepts the graph, plugin container, and hot transport accounting', () => {
    const seams = readSsrEnvironment(environment);
    expect(seams.hotTransportEmitter.listenerCount('send')).toBe(0);
    expect(typeof seams.pluginContainer.resolveId).toBe('function');
  });

  it('fails closed without the module graph', () => {
    expectSeamRejection(
      () => readSsrEnvironment({ ...environment, moduleGraph: {} }),
      'vite SSR environment (module graph, plugin container, hot transport)',
      'fail-closed private',
    );
  });

  it('fails closed without the plugin container', () => {
    expectSeamRejection(
      () => readSsrEnvironment({ ...environment, pluginContainer: undefined }),
      'vite SSR environment (module graph, plugin container, hot transport)',
      'fail-closed private',
    );
  });

  it('fails closed without the outsideEmitter listener accounting', () => {
    expectSeamRejection(
      () => readSsrEnvironment({ ...environment, hot: { api: {} } }),
      'vite SSR environment (module graph, plugin container, hot transport)',
      'fail-closed private',
    );
  });
});

describe('readClientEnvironment (fail-closed private seams)', () => {
  const client = {
    transformRequest: async () => ({ code: '' }),
    moduleGraph: { getModuleById: () => null, getModuleByUrl: () => null },
    pluginContainer: { resolveId: async () => null },
  };

  it('accepts the transform + ownership surface', () => {
    expect(typeof readClientEnvironment(client).transformRequest).toBe('function');
  });

  it('fails closed on every missing piece', () => {
    const seam = 'vite client environment (transformRequest, module graph, plugin container)';
    expectSeamRejection(
      () => readClientEnvironment({ ...client, transformRequest: undefined }),
      seam,
      'fail-closed private',
    );
    expectSeamRejection(
      () => readClientEnvironment({ ...client, moduleGraph: { getModuleById: () => null } }),
      seam,
      'fail-closed private',
    );
    expectSeamRejection(
      () => readClientEnvironment({ ...client, pluginContainer: null }),
      seam,
      'fail-closed private',
    );
    expectSeamRejection(() => readClientEnvironment(null), seam, 'fail-closed private');
  });
});

describe('readTransformedModule (fail-closed private seam)', () => {
  const graph = {
    getModuleById: () => ({ transformResult: { code: 'const x = 1' } }),
  };

  it('accepts a transformed module with non-empty code', () => {
    expect(readTransformedModule(graph, '/src/x.astro?astro&type=style&index=0').code).toBe(
      'const x = 1',
    );
  });

  it('fails closed on an absent node and on empty code', () => {
    const seam = 'vite module graph transformed module';
    expectSeamRejection(
      () => readTransformedModule({ getModuleById: () => undefined }, 'x'),
      seam,
      'fail-closed private',
    );
    expectSeamRejection(
      () =>
        readTransformedModule({ getModuleById: () => ({ transformResult: { code: '' } }) }, 'x'),
      seam,
      'fail-closed private',
    );
    expectSeamRejection(
      () => readTransformedModule({ getModuleById: () => ({}) }, 'x'),
      seam,
      'fail-closed private',
    );
  });
});

describe('readRouteEntries (virtual:astro:routes, fail-closed private)', () => {
  it('accepts the certified export shape', () => {
    expect(
      readRouteEntries({
        routes: [
          {
            routeData: {
              route: '/blog/[slug]',
              component: 'src/pages/blog/[slug].astro',
              type: 'page',
            },
          },
          { routeData: { route: '/', component: 'src/pages/index.astro', type: 'page' } },
        ],
      }),
    ).toEqual([
      { pattern: '/blog/[slug]', component: 'src/pages/blog/[slug].astro', type: 'page' },
      { pattern: '/', component: 'src/pages/index.astro', type: 'page' },
    ]);
  });

  it('fails closed when the export or a route drifts', () => {
    const seam = 'virtual:astro:routes export';
    expectSeamRejection(() => readRouteEntries({ routesById: {} }), seam, 'fail-closed private');
    expectSeamRejection(
      () => readRouteEntries({ routes: [{ routeData: { pathname: '/x' } }] }),
      seam,
      'fail-closed private',
    );
    expectSeamRejection(
      () => readRouteEntries({ routes: 'all routes' }),
      seam,
      'fail-closed private',
    );
  });
});

describe('readDevCssEntries (virtual:astro:dev-css, fail-closed private)', () => {
  it('accepts the certified Set shape', () => {
    expect(
      readDevCssEntries({
        css: new Set([
          {
            content: '.hero-title[data-astro-cid-a] { color: red; }',
            id: '/p/src/pages/index.astro?astro&type=style&index=0&lang.css',
            url: '/src/pages/index.astro?astro&type=style&index=0&lang.css',
          },
        ]),
      }),
    ).toEqual([
      {
        content: '.hero-title[data-astro-cid-a] { color: red; }',
        id: '/p/src/pages/index.astro?astro&type=style&index=0&lang.css',
        url: '/src/pages/index.astro?astro&type=style&index=0&lang.css',
      },
    ]);
  });

  it('fails closed when css is not a Set or an entry drifts', () => {
    const seam = 'virtual:astro:dev-css export';
    expectSeamRejection(
      () => readDevCssEntries({ css: [{ code: '.x {}' }] }),
      seam,
      'fail-closed private',
    );
    expectSeamRejection(
      () => readDevCssEntries({ css: new Set([{ content: '.x {}', id: '/x' }]) }),
      seam,
      'fail-closed private',
    );
  });
});

describe('readViteClientCss (__vite__css sentinel, fail-closed private)', () => {
  it('reads the certified sentinel assignment', () => {
    expect(
      readViteClientCss(
        'const __vite__css = ".hero-title[data-astro-cid-proof] {\\n color: red;\\n}"',
      ),
    ).toBe('.hero-title[data-astro-cid-proof] {\n color: red;\n}');
  });

  it('fails closed without the sentinel, on non-string literals, and on non-JSON literals', () => {
    const seam = 'vite client CSS __vite__css sentinel';
    expectSeamRejection(() => readViteClientCss('export default {}'), seam, 'fail-closed private');
    expectSeamRejection(
      () => readViteClientCss('const __vite__css = 42'),
      seam,
      'fail-closed private',
    );
    expectSeamRejection(
      () => readViteClientCss('const __vite__css = {"a":1}'),
      seam,
      'fail-closed private',
    );
  });
});
