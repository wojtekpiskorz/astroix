import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CompositionServer } from '../../astro-project-adapter/composition';
import type { RouteMetadataEntry } from '../../astro-project-adapter/routes/route-metadata';
import type { ModuleRunnerLike } from '../../astro-project-adapter/seam-readers';

/**
 * The #229 focused-test stand-ins (#225 idiom): fakes at the SEAM layer
 * only. The raw `virtual:astro:routes` export mirrors the certified
 * astro@7.2.10 output for the canonical fixture (`vite-plugin-routes` →
 * `serializeRouteData` → `deserializeRouteInfo`, live `RegExp`/`URL`
 * fields included so the reader is proven to drop them), and the fake
 * runner mirrors the real pin discipline (close removes the send
 * listeners it pinned). Real Astro behavior behind these seams stays
 * proven by the certification suite — the behavior layer is never faked
 * as a compatibility claim.
 */

/** The canonical fixture's blog entry ids, code-unit order (the corpus's collection order). */
export const BLOG_IDS = ['2024/post', '2025/release-notes', 'hello-builder'] as const;

/** Indexed access with a presence proof — the fixture arrays are test constants. */
export function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`fixture index ${index} is missing`);
  return value;
}

export const VIRTUAL_ROUTES_MODULE = 'virtual:astro:routes';

/** The fake managed project root — a virtual path; the fake runner never touches the filesystem. */
export const FAKE_PROJECT_ROOT = '/managed/fixture';

/** A route's entrypoint id as the enumeration pass builds it from the seam's component field. */
export function entrypointOf(component: string): string {
  return pathToFileURL(join(FAKE_PROJECT_ROOT, component)).href;
}

function segmentPart(content: string, dynamic: boolean, spread: boolean) {
  return { content, dynamic, spread };
}

/** The raw `routeData` envelope the certified seam carries — certified fields plus live junk the reader must drop. */
export function rawRouteData(input: {
  route: string;
  component?: string;
  type?: string;
  origin?: string;
  prerender?: boolean;
  params?: string[];
  segments?: unknown;
}): Record<string, unknown> {
  return {
    route: input.route,
    component: input.component,
    type: input.type ?? 'page',
    origin: input.origin ?? 'project',
    prerender: input.prerender ?? true,
    params: input.params ?? [],
    segments:
      input.segments ??
      input.route
        .split('/')
        .filter((part) => part.length > 0)
        .map((part) => {
          if (part.startsWith('[...')) {
            return [segmentPart(part.slice(1, -1), true, true)];
          }
          if (part.startsWith('[')) {
            return [segmentPart(part.slice(1, -1), true, false)];
          }
          return [segmentPart(part, false, false)];
        }),
    // live module-graph fields the certified export also carries — never read, never held
    pattern: new RegExp(input.route),
    isIndex: false,
    fallbackRoutes: [],
    distURL: [],
    pathname: input.params?.length === 0 ? input.route : undefined,
  };
}

/** One seam entry — the `{file, links, scripts, styles, routeData}` envelope `vite-plugin-routes` serializes. */
function routeEntry(routeData: Record<string, unknown> | null): unknown {
  return { file: '', links: [], scripts: [], styles: [], routeData };
}

/** The canonical fixture's raw `virtual:astro:routes` export, as astro@7.2.10 hands it over. */
export function fixtureVirtualRoutesExport(
  overrides: { readonly routeData?: ReadonlyArray<Record<string, unknown> | null> } = {},
): unknown {
  const routeData =
    overrides.routeData === undefined
      ? [
          // astro core UNSHIFTS the internal server-islands route first.
          rawRouteData({
            route: '/_server-islands/[name]',
            component: '_server-islands.astro',
            origin: 'internal',
            prerender: false,
            params: ['name'],
          }),
          rawRouteData({ route: '/', component: 'src/pages/index.astro' }),
          rawRouteData({
            route: '/blog/[slug]',
            component: 'src/pages/blog/[slug].astro',
            params: ['slug'],
          }),
          rawRouteData({
            route: '/blog/[...slug]',
            component: 'src/pages/blog/[...slug].astro',
            params: ['...slug'],
          }),
        ]
      : overrides.routeData;
  return { routes: routeData.map(routeEntry) };
}

/** The canonical fixture's metadata after the reader — the typed truth the projection consumes. */
export function fixtureRouteMetadata(): RouteMetadataEntry[] {
  const entries = [
    {
      pattern: '/_server-islands/[name]',
      component: '_server-islands.astro',
      type: 'page',
      origin: 'internal',
      prerender: false,
      params: ['name'],
      segments: [
        [segmentPart('_server-islands', false, false)],
        [segmentPart('name', true, false)],
      ],
    },
    {
      pattern: '/',
      component: 'src/pages/index.astro',
      type: 'page',
      origin: 'project',
      prerender: true,
      params: [],
      segments: [],
    },
    {
      pattern: '/blog/[slug]',
      component: 'src/pages/blog/[slug].astro',
      type: 'page',
      origin: 'project',
      prerender: true,
      params: ['slug'],
      segments: [[segmentPart('blog', false, false)], [segmentPart('slug', true, false)]],
    },
    {
      pattern: '/blog/[...slug]',
      component: 'src/pages/blog/[...slug].astro',
      type: 'page',
      origin: 'project',
      prerender: true,
      params: ['...slug'],
      segments: [[segmentPart('blog', false, false)], [segmentPart('...slug', true, true)]],
    },
  ] as const as RouteMetadataEntry[];
  return entries.map((entry) => ({ ...entry, params: [...entry.params] }));
}

/**
 * The fixture pages' own `getStaticPaths` behavior, mirrored from
 * `e2e/fixture/src/pages/blog/`: the segment-param page renders only flat
 * ids, the catch-all renders every blog id.
 */
export function fixtureRouteModules(): Map<string, object> {
  return new Map([
    [
      'src/pages/blog/[slug].astro',
      {
        getStaticPaths: async () =>
          BLOG_IDS.filter((id) => !id.includes('/')).map((id) => ({ params: { slug: id } })),
      },
    ],
    [
      'src/pages/blog/[...slug].astro',
      {
        getStaticPaths: async () => BLOG_IDS.map((id) => ({ params: { slug: id } })),
      },
    ],
  ]);
}

/** A fake module the runner may serve for a component, plus its failure knobs. */
export interface FakeRunnerOptions {
  /** Defaults to the fixture export; a malformed shape here exercises the fail-closed reader. */
  readonly virtualRoutesExport?: unknown;
  /** The virtual-routes import never settles — the metadata read's hang. */
  readonly hangingVirtualRoutesImport?: boolean;
  /** Modules by component path; a missing entry serves `{}` (import succeeded, no getStaticPaths). */
  readonly modules?: ReadonlyMap<string, object>;
  /** Components whose import rejects — module evaluation failure. */
  readonly failingComponents?: readonly string[];
  /** Components whose import never settles — the per-wait bound's hang. */
  readonly hangingComponents?: readonly string[];
}

/** A fake runner that mirrors the real pin discipline: close() removes the send listeners. */
export class FakeRunner implements ModuleRunnerLike {
  readonly importedIds: string[] = [];
  private readonly listenersPinned = 2;
  private closed = false;

  constructor(
    private readonly emitter: EventEmitter,
    private readonly options: FakeRunnerOptions,
  ) {
    for (let i = 0; i < this.listenersPinned; i += 1) {
      this.emitter.on('send', () => {});
    }
  }

  async import(id: string): Promise<unknown> {
    this.importedIds.push(id);
    if (id === VIRTUAL_ROUTES_MODULE) {
      if (this.options.hangingVirtualRoutesImport) return new Promise<never>(() => {});
      return this.options.virtualRoutesExport ?? fixtureVirtualRoutesExport();
    }
    const component = [...knownComponents(this.options)].find(
      (candidate) => entrypointOf(candidate) === id,
    );
    if (component === undefined) return {};
    if (this.options.failingComponents?.includes(component)) {
      throw new Error('module evaluation failed');
    }
    if (this.options.hangingComponents?.includes(component)) {
      return new Promise<never>(() => {});
    }
    return this.options.modules?.get(component) ?? fixtureRouteModules().get(component) ?? {};
  }

  async close(): Promise<void> {
    for (const listener of this.emitter.listeners('send').slice(0, this.listenersPinned)) {
      this.emitter.removeListener('send', listener);
    }
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function knownComponents(options: FakeRunnerOptions): Set<string> {
  return new Set([
    ...fixtureRouteModules().keys(),
    ...(options.modules?.keys() ?? []),
    ...(options.failingComponents ?? []),
    ...(options.hangingComponents ?? []),
  ]);
}

/** A composition-server stand-in: one SSR environment whose runners the harness hands out. */
export interface FakeCompositionHarness {
  readonly composition: CompositionServer;
  readonly emitter: EventEmitter;
  readonly runners: FakeRunner[];
}

export function fakeComposition(options: FakeRunnerOptions = {}): FakeCompositionHarness {
  const emitter = new EventEmitter();
  const runners: FakeRunner[] = [];
  const environment = {
    moduleGraph: { getModuleById: () => null },
    pluginContainer: { resolveId: async () => null },
    hot: { api: { outsideEmitter: emitter } },
  };
  const composition = {
    seams: {
      certifiedPair: { astro: '7.2.10', vite: '8.2.2' },
      projectRoot: FAKE_PROJECT_ROOT,
      getViteConfig: () => async () => ({}),
      getDevCSSModuleName: (componentId: string) => `virtual:astro:dev-css:${componentId}`,
      vite: {
        createServer: async () => ({}),
        createServerModuleRunner: () => {
          const runner = new FakeRunner(emitter, options);
          runners.push(runner);
          return runner;
        },
      },
    },
    server: {
      environments: { ssr: environment, client: {} },
      watcher: { on: () => ({}) },
      close: async () => {},
    },
    close: async () => {},
  };
  return { composition: composition as unknown as CompositionServer, emitter, runners };
}
