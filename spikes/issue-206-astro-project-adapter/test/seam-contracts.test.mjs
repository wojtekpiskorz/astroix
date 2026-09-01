import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readAstroInternalCssUtil,
  readClientEnvironment,
  readDevCssEntries,
  readRouteEntries,
  readRunnerContract,
  readSsrEnvironment,
  readTransformedModule,
  readViteClientCss,
  readViteRuntime,
} from '../src/seam-contracts.mjs';

test('route inspection accepts the certified virtual-module shape', () => {
  assert.deepEqual(
    readRouteEntries({
      routes: [
        {
          routeData: {
            component: 'src/pages/blog/[slug].astro',
            route: '/blog/[slug]',
            type: 'page',
          },
        },
      ],
    }),
    [
      {
        component: 'src/pages/blog/[slug].astro',
        pattern: '/blog/[slug]',
        type: 'page',
      },
    ],
  );
});

test('route inspection fails closed when Astro changes its private shape', () => {
  assert.throws(
    () => readRouteEntries({ routes: [{ routeData: { pathname: '/blog/[slug]' } }] }),
    /AstroProjectAdapter private seam rejection: virtual:astro:routes route 0 lacks string routeData.route, routeData.component, or routeData.type/,
  );
});

test('compiled CSS inspection accepts the certified Set entry shape', () => {
  assert.deepEqual(
    readDevCssEntries({
      css: new Set([
        {
          content: '.hero-title[data-astro-cid-a] { color: red; }',
          id: '/project/src/pages/index.astro?astro&type=style&index=0&lang.css',
          url: '/src/pages/index.astro?astro&type=style&index=0&lang.css',
        },
      ]),
    }),
    [
      {
        content: '.hero-title[data-astro-cid-a] { color: red; }',
        id: '/project/src/pages/index.astro?astro&type=style&index=0&lang.css',
        url: '/src/pages/index.astro?astro&type=style&index=0&lang.css',
      },
    ],
  );
});

test('compiled CSS inspection fails closed when Astro changes its private shape', () => {
  assert.throws(
    () => readDevCssEntries({ css: [{ code: '.hero-title {}' }] }),
    /AstroProjectAdapter private seam rejection: virtual:astro:dev-css export css is not a Set/,
  );
});

test('client CSS inspection reads Vite 8 transformed __vite__css', () => {
  assert.equal(
    readViteClientCss(
      'const __vite__css = ".hero-title[data-astro-cid-proof] {\\n color: red;\\n}"',
    ),
    '.hero-title[data-astro-cid-proof] {\n color: red;\n}',
  );
});

test('client CSS inspection fails closed when Vite changes its transformed shape', () => {
  assert.throws(
    () => readViteClientCss('export default ".hero-title {}"'),
    /AstroProjectAdapter private seam rejection: Vite client CSS transform has no string __vite__css assignment/,
  );
});

test('internal Astro CSS utility inspection fails closed when the private export moves', () => {
  assert.throws(
    () => readAstroInternalCssUtil({}, '/astro/dist/vite-plugin-css/util.js'),
    /AstroProjectAdapter private seam rejection: internal Astro module \/astro\/dist\/vite-plugin-css\/util\.js has no getDevCSSModuleName function/,
  );
});

test('Vite runtime inspection fails closed when the experimental runner factory moves', () => {
  assert.throws(
    () => readViteRuntime({ createServer() {} }),
    /AstroProjectAdapter private seam rejection: Vite runtime has no createServerModuleRunner function/,
  );
});

test('runner inspection fails closed when lifecycle methods change', () => {
  assert.throws(
    () => readRunnerContract({ close() {} }),
    /AstroProjectAdapter private seam rejection: Vite module runner has no close and isClosed functions/,
  );
});

test('SSR environment inspection fails closed when hot listener accounting changes', () => {
  assert.throws(
    () =>
      readSsrEnvironment({
        hot: {},
        moduleGraph: { getModuleById() {} },
        pluginContainer: { resolveId() {} },
      }),
    /AstroProjectAdapter private seam rejection: Vite runner hot transport lacks outsideEmitter listener accounting/,
  );
});

test('client environment inspection fails closed when environment APIs change', () => {
  assert.throws(
    () => readClientEnvironment({ moduleGraph: {}, pluginContainer: {} }),
    /AstroProjectAdapter private seam rejection: Vite client environment lacks transformRequest, module graph, or plugin container/,
  );
});

test('module graph inspection fails closed on a null transform result', () => {
  assert.throws(
    () =>
      readTransformedModule(
        { getModuleById: () => ({ transformResult: null }) },
        '/src/pages/index.astro?astro&type=style&index=0&lang.css',
      ),
    /AstroProjectAdapter private seam rejection: Vite module graph has no transformed \/src\/pages\/index\.astro\?astro&type=style&index=0&lang\.css node/,
  );
});
