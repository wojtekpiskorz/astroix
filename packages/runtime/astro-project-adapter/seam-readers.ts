import type { AdapterErrorDetails, SeamClass } from './adapter-error';
import { AdapterError, observedShape } from './adapter-error';

/**
 * The fail-closed seam probes (ADR-0005, `docs/core-reuse.md` seam
 * classes): every version-sensitive Astro/Vite mechanism the adapter
 * touches enters through one of these readers, which verify the exact
 * certified shape and throw `seam-rejected` (naming the seam, its class,
 * the expected shape, and a structural observed description) when the
 * observed shape differs. The adapter never guesses routes, schemas, or
 * selectors: an unknown shape is a compatibility event, diagnosed from
 * the rejection — never heuristically parsed.
 *
 * Inputs are deliberately `unknown`: Astro and Vite resolve from the
 * managed project's installation (never from Astroix's own), so these
 * probes — not the type checker against some other installation's types
 * — are the contract. Each reader's accepted shape is the one proven for
 * the certified pair `astro@7.2.10 + vite@8.2.2` (#206); re-proving them
 * for a new pair is the certification update.
 */

// ——— the seam inventory (named per docs/core-reuse.md's table) ———

const SEAM_GET_VITE_CONFIG = 'astro/config#getViteConfig()';
const SEAM_VITE_CREATE_SERVER = 'vite root export createServer()';
const SEAM_VITE_RUNNER_FACTORY = 'vite root export createServerModuleRunner()';
const SEAM_ASTRO_CSS_UTIL = 'astro internal dist/vite-plugin-css/util.js#getDevCSSModuleName';
const SEAM_RUNNER_LIFECYCLE = 'vite module runner lifecycle (import, close, isClosed)';
const SEAM_SSR_ENVIRONMENT = 'vite SSR environment (module graph, plugin container, hot transport)';
const SEAM_CLIENT_ENVIRONMENT =
  'vite client environment (transformRequest, module graph, plugin container)';
const SEAM_TRANSFORMED_MODULE = 'vite module graph transformed module';
const SEAM_ROUTES_EXPORT = 'virtual:astro:routes export';
const SEAM_DEV_CSS_EXPORT = 'virtual:astro:dev-css export';
const SEAM_VITE_CSS_SENTINEL = 'vite client CSS __vite__css sentinel';

// ——— the structural likes the adapter hands its callers ———

/** Vite's root-exported server + runner factory, resolved from the managed project. */
export interface ViteRuntimeSeams {
  readonly createServer: (config: unknown) => Promise<ViteServerLike>;
  readonly createServerModuleRunner: (environment: unknown) => ModuleRunnerLike;
}

/** The slice of a Vite dev server the adapter consumes (per-environment graphs, watcher, close). */
export interface ViteServerLike {
  readonly environments: { readonly ssr: unknown; readonly client: unknown };
  readonly watcher: { on(event: string, listener: (...args: never[]) => void): unknown };
  close(): Promise<void>;
}

/** The fresh module-runner lifecycle the adapter depends on (public seam). */
export interface ModuleRunnerLike {
  import(id: string): Promise<unknown>;
  close(): Promise<void>;
  isClosed(): boolean;
}

/** The SSR environment pieces inspection needs: graph, plugin container, hot transport accounting. */
export interface SsrEnvironmentSeams {
  /** The SSR hot transport emitter — its pinned `send` listener is the fresh-runner leak (#206). */
  readonly hotTransportEmitter: SendListenerAccounting;
  readonly moduleGraph: ModuleGraphLike;
  readonly pluginContainer: PluginContainerLike;
}

export interface SendListenerAccounting {
  listenerCount(event: 'send'): number;
}

export interface ModuleGraphLike {
  getModuleById(id: string): unknown;
  /**
   * The certified Vite's own `getModuleByUrl` is asynchronous (a promise
   * of the node) while `getModuleById` is synchronous — the return type
   * is `unknown` on purpose and callers must `await` it (a plain value
   * awaits to itself; comparing the promise would always mismatch).
   */
  getModuleByUrl(url: string): unknown;
}

export interface PluginContainerLike {
  resolveId(id: string): Promise<unknown>;
}

/** A client environment that transforms and owns compiled CSS modules. */
export interface ClientEnvironmentSeams {
  transformRequest(url: string): Promise<{ code: string } | null>;
  readonly moduleGraph: ModuleGraphLike;
  readonly pluginContainer: PluginContainerLike;
}

/** One route from `virtual:astro:routes` — pattern, component file, and route type. */
export interface RouteSeamEntry {
  readonly pattern: string;
  readonly component: string;
  readonly type: string;
}

/** One `{id, url, content}` entry of `virtual:astro:dev-css:{component}`'s `css` set. */
export interface DevCssSeamEntry {
  readonly id: string;
  readonly url: string;
  readonly content: string;
}

// ——— the probes ———

function seamRejected(
  seam: string,
  seamClass: SeamClass,
  expected: string,
  observed: string,
): AdapterError {
  const details: AdapterErrorDetails = { seam, seamClass, expected, observed };
  return new AdapterError('seam-rejected', seamMessage(seam, expected, observed), details);
}

function seamMessage(seam: string, expected: string, observed: string): string {
  return `AstroProjectAdapter seam rejection at ${seam}: expected ${expected}; observed ${observed}`;
}

/** `astro/config#getViteConfig` — public seam. */
export function readGetViteConfig(
  moduleExports: unknown,
): (
  inlineConfig: unknown,
  rootConfig?: unknown,
) => (options: { command: string; mode: string }) => Promise<unknown> {
  const getViteConfig = (moduleExports as { getViteConfig?: unknown })?.getViteConfig;
  if (typeof getViteConfig !== 'function') {
    throw seamRejected(
      SEAM_GET_VITE_CONFIG,
      'public',
      'a function getViteConfig',
      observedShape(moduleExports),
    );
  }
  return getViteConfig as ReturnType<typeof readGetViteConfig>;
}

/** Vite's root exports: `createServer` (public) and the experimental `createServerModuleRunner` (certified exact-pair). */
export function readViteRuntime(moduleExports: unknown): ViteRuntimeSeams {
  const createServer = (moduleExports as { createServer?: unknown })?.createServer;
  const createServerModuleRunner = (moduleExports as { createServerModuleRunner?: unknown })
    ?.createServerModuleRunner;
  if (typeof createServer !== 'function') {
    throw seamRejected(
      SEAM_VITE_CREATE_SERVER,
      'public',
      'a function createServer',
      observedShape(moduleExports),
    );
  }
  if (typeof createServerModuleRunner !== 'function') {
    throw seamRejected(
      SEAM_VITE_RUNNER_FACTORY,
      'certified exact-pair',
      'a function createServerModuleRunner (experimental at the certified pin)',
      observedShape(moduleExports),
    );
  }
  return {
    createServer: createServer as ViteRuntimeSeams['createServer'],
    createServerModuleRunner:
      createServerModuleRunner as ViteRuntimeSeams['createServerModuleRunner'],
  };
}

/** Astro's internal CSS utility that names a route component's dev-css virtual module — fail-closed private. */
export function readAstroCssUtil(moduleExports: unknown): (componentId: string) => string {
  const util = (moduleExports as { getDevCSSModuleName?: unknown })?.getDevCSSModuleName;
  if (typeof util !== 'function') {
    throw seamRejected(
      SEAM_ASTRO_CSS_UTIL,
      'fail-closed private',
      'a function getDevCSSModuleName',
      observedShape(moduleExports),
    );
  }
  return util as (componentId: string) => string;
}

/** The module-runner lifecycle surface — public seam. */
export function readRunnerContract(runner: unknown): ModuleRunnerLike {
  const candidate = runner as Partial<ModuleRunnerLike> | null;
  if (
    candidate === null ||
    typeof candidate.import !== 'function' ||
    typeof candidate.close !== 'function' ||
    typeof candidate.isClosed !== 'function'
  ) {
    throw seamRejected(
      SEAM_RUNNER_LIFECYCLE,
      'public',
      'an object with functions import, close, isClosed',
      observedShape(runner),
    );
  }
  return candidate as ModuleRunnerLike;
}

/** The SSR environment's graph, plugin container, and hot-transport listener accounting — private seams. */
export function readSsrEnvironment(environment: unknown): SsrEnvironmentSeams {
  const candidate = environment as {
    moduleGraph?: unknown;
    pluginContainer?: unknown;
    hot?: { api?: { outsideEmitter?: unknown } };
  } | null;
  const graph = candidate?.moduleGraph as ModuleGraphLike | null | undefined;
  const pluginContainer = candidate?.pluginContainer as PluginContainerLike | null | undefined;
  const emitter = candidate?.hot?.api?.outsideEmitter as SendListenerAccounting | null | undefined;
  if (graph === null || graph === undefined || typeof graph.getModuleById !== 'function') {
    throw seamRejected(
      SEAM_SSR_ENVIRONMENT,
      'fail-closed private',
      'a module graph with a getModuleById function',
      observedShape(environment),
    );
  }
  if (
    pluginContainer === null ||
    pluginContainer === undefined ||
    typeof pluginContainer.resolveId !== 'function'
  ) {
    throw seamRejected(
      SEAM_SSR_ENVIRONMENT,
      'fail-closed private',
      'a plugin container with a resolveId function',
      observedShape(environment),
    );
  }
  if (emitter === null || emitter === undefined || typeof emitter.listenerCount !== 'function') {
    throw seamRejected(
      SEAM_SSR_ENVIRONMENT,
      'fail-closed private',
      'a hot transport outsideEmitter with send listener accounting',
      observedShape(environment),
    );
  }
  return { hotTransportEmitter: emitter, moduleGraph: graph, pluginContainer };
}

/**
 * The client environment's transform + graph-ownership surface — private
 * seams. Returns the probed environment ITSELF, never a destructured
 * wrapper: `transformRequest` is an own method whose `this` must stay the
 * real environment (Vite reads `this._pendingRequests`), so rebinding it
 * onto a wrapper object would corrupt the seam.
 */
export function readClientEnvironment(environment: unknown): ClientEnvironmentSeams {
  const candidate = environment as {
    transformRequest?: unknown;
    moduleGraph?: ModuleGraphLike | null;
    pluginContainer?: PluginContainerLike | null;
  } | null;
  const { transformRequest, moduleGraph, pluginContainer } = candidate ?? {};
  if (
    typeof transformRequest !== 'function' ||
    moduleGraph === null ||
    moduleGraph === undefined ||
    typeof moduleGraph.getModuleByUrl !== 'function' ||
    typeof moduleGraph.getModuleById !== 'function' ||
    pluginContainer === null ||
    pluginContainer === undefined ||
    typeof pluginContainer.resolveId !== 'function'
  ) {
    throw seamRejected(
      SEAM_CLIENT_ENVIRONMENT,
      'fail-closed private',
      'transformRequest, module graph (getModuleByUrl, getModuleById), and plugin container functions',
      observedShape(environment),
    );
  }
  return candidate as ClientEnvironmentSeams;
}

/** A module graph's transformed module code — the compiled-CSS read path. */
export function readTransformedModule(graph: unknown, id: string): { code: string; node: unknown } {
  const node = (graph as ModuleGraphLike | null)?.getModuleById?.(id) as
    | { transformResult?: { code?: unknown } }
    | undefined;
  const code = node?.transformResult?.code;
  if (typeof code !== 'string' || code.length === 0) {
    throw seamRejected(
      SEAM_TRANSFORMED_MODULE,
      'fail-closed private',
      'a transformed module node with non-empty string transformResult.code',
      observedShape(node),
    );
  }
  return { code, node };
}

/** The `virtual:astro:routes` export shape — fail-closed private. */
export function readRouteEntries(moduleExports: unknown): RouteSeamEntry[] {
  const routes = (moduleExports as { routes?: unknown })?.routes;
  if (!Array.isArray(routes)) {
    throw seamRejected(
      SEAM_ROUTES_EXPORT,
      'fail-closed private',
      'an array routes export',
      observedShape(moduleExports),
    );
  }
  return routes.map((route, index) => {
    const data = (route as { routeData?: { route?: unknown; component?: unknown; type?: unknown } })
      ?.routeData;
    if (
      typeof data?.route !== 'string' ||
      typeof data.component !== 'string' ||
      typeof data.type !== 'string'
    ) {
      throw seamRejected(
        SEAM_ROUTES_EXPORT,
        'fail-closed private',
        `route ${index} with string routeData.route, routeData.component, and routeData.type`,
        observedShape(route),
      );
    }
    return { pattern: data.route, component: data.component, type: data.type };
  });
}

/** The `virtual:astro:dev-css:{component}` export shape — fail-closed private. */
export function readDevCssEntries(moduleExports: unknown): DevCssSeamEntry[] {
  const css = (moduleExports as { css?: unknown })?.css;
  if (!(css instanceof Set)) {
    throw seamRejected(
      SEAM_DEV_CSS_EXPORT,
      'fail-closed private',
      'a Set css export',
      observedShape(moduleExports),
    );
  }
  return [...css].map((entry, index) => {
    const candidate = entry as { content?: unknown; id?: unknown; url?: unknown } | null;
    if (
      typeof candidate?.content !== 'string' ||
      typeof candidate.id !== 'string' ||
      typeof candidate.url !== 'string'
    ) {
      throw seamRejected(
        SEAM_DEV_CSS_EXPORT,
        'fail-closed private',
        `entry ${index} with string content, id, and url`,
        observedShape(entry),
      );
    }
    return { content: candidate.content, id: candidate.id, url: candidate.url };
  });
}

const VITE_CSS_SENTINEL = /__vite__css = ("(?:[^"\\]|\\.)*")/;

/** Vite's client CSS transform sentinel — the compiled CSS extraction path, fail-closed private. */
export function readViteClientCss(code: string): string {
  const match = code.match(VITE_CSS_SENTINEL);
  if (match?.[1] === undefined) {
    throw seamRejected(
      SEAM_VITE_CSS_SENTINEL,
      'fail-closed private',
      'a string __vite__css assignment in the transformed module code',
      'no sentinel assignment present',
    );
  }
  try {
    const css = JSON.parse(match[1]) as unknown;
    if (typeof css === 'string') return css;
  } catch {
    // fall through to the rejection below — an unreadable sentinel is a drift
  }
  throw seamRejected(
    SEAM_VITE_CSS_SENTINEL,
    'fail-closed private',
    'a JSON string literal assigning __vite__css',
    'a sentinel literal that does not decode to a string',
  );
}
