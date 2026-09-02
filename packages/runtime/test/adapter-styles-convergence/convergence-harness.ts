import { EventEmitter } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectRuntimeSeams } from '../../astro-project-adapter/composition';
import type { ViteServerLike } from '../../astro-project-adapter/seam-readers';

/**
 * The convergence lane's composition stand-ins (#227): a disposable temp
 * copy of the canonical fixture's `src` (the static walk reads REAL disk
 * bytes, and the convergence tests edit them), a runner that pins real
 * `send` listeners like the certified one (so listener restoration is
 * accounted, not asserted), and a client environment whose compiled CSS
 * is a knob — the stale/fresh lever the transient-mismatch tests flip.
 * Real Astro/Vite behavior behind the seams stays the certification
 * suite's truth (#225); these stand-ins exercise the convergence
 * protocol's own wiring only.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE_SRC = join(REPO_ROOT, 'e2e', 'fixture', 'src');
export const ROUTE_COMPONENT = 'src/pages/index.astro';
export const DEV_CSS_MODULE = `virtual:astro:dev-css:${ROUTE_COMPONENT}`;
export const FIXTURE_SCOPED_SELECTOR = '.hero-title';
export const FIXTURE_SCOPE_TOKEN = 'data-astro-cid-lcdefpme';

/** A fake runner mirroring the real pin discipline: construction pins 3 `send` listeners, close removes them. */
class FakeRunner {
  closed = false;

  constructor(
    private readonly emitter: EventEmitter,
    private readonly behavior: { readonly surviveClose?: boolean },
    private readonly importDevCss: () => Promise<unknown>,
  ) {
    for (let i = 0; i < 3; i += 1) {
      this.emitter.on('send', () => {});
    }
  }

  async import(id: string): Promise<unknown> {
    if (id !== DEV_CSS_MODULE) throw new Error(`unexpected import ${id}`);
    return this.importDevCss();
  }

  async close(): Promise<void> {
    if (this.behavior.surviveClose) return;
    for (const listener of this.emitter.listeners('send').slice(0, 3)) {
      this.emitter.removeListener('send', listener);
    }
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/** The compiled-CSS knobs one pass observes in the client environment. */
export interface HarnessCss {
  /** The compiled scoped CSS served for the active route's style module (stale until the graph re-serves). */
  compiledCss: string;
  /** Per-transform schedule: each style transform shifts the front; exhaustion falls back to `compiledCss`. */
  scheduled: string[];
  /** Flip to break the page prime (an AdapterError failure path). */
  pagePrimeBroken: boolean;
  /** Hook fired when the style module is transformed (mid-pass watcher-race lever). */
  onStyleTransform?: () => void;
  readonly styleTransformCount: number;
  /** Hook fired before the runner imports the dev-css module (pass-start lever). */
  onDevCssImport?: () => void;
}

export interface ConvergenceHarness {
  readonly server: ViteServerLike;
  readonly seams: ProjectRuntimeSeams;
  readonly projectRoot: string;
  readonly watcher: EventEmitter;
  /** The SSR hot transport emitter — the runner's pinned `send` listeners are accounted here. */
  readonly hotEmitter: EventEmitter;
  readonly css: HarnessCss;
  readonly runners: FakeRunner[];
  /** Overrides the dev-css import behavior — the module set the route pass observes. */
  setDevCssImport(impl: () => Promise<unknown>): void;
  readonly runnerFactoryCalls: number[];
  /** Fires a watcher `change` for a project-relative file (the invalidation event). */
  fireWatcherChange(relativeFile: string): void;
  /** Rewrites the scoped selector in the fixture page's style block on disk (no watcher event). */
  editScopedSelector(next: string): Promise<void>;
  /** Replaces the fixture page's whole style block with the given rules on disk (no watcher event). */
  replaceStyleBlock(rules: readonly string[]): Promise<void>;
  dispose(): Promise<void>;
}

/** The fixture-faithful compiled CSS: the frozen corpus's attribute-form selector. */
export function fixtureCompiledCss(selector = FIXTURE_SCOPED_SELECTOR): string {
  return `${selector}[${FIXTURE_SCOPE_TOKEN}] { color: #1e293b; }`;
}

function styleUrl(): string {
  return `/${ROUTE_COMPONENT}?astro&type=style&index=0&lang.css`;
}

export async function convergenceHarness(
  options: { readonly runnerBehavior?: { readonly surviveClose?: boolean } } = {},
): Promise<ConvergenceHarness> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'astroix-227-'));
  await cp(FIXTURE_SRC, join(projectRoot, 'src'), { recursive: true });

  const emitter = new EventEmitter();
  const watcher = new EventEmitter();
  let styleTransformCount = 0;
  const css: HarnessCss = {
    compiledCss: fixtureCompiledCss(),
    scheduled: [],
    pagePrimeBroken: false,
    get styleTransformCount() {
      return styleTransformCount;
    },
  };
  const harness: ConvergenceHarness = {} as ConvergenceHarness;
  const devCssImportRef: { current: () => Promise<unknown> } = {
    current: async () => ({
      css: new Set([
        {
          id: `/abs/proj/${ROUTE_COMPONENT}?astro&type=style&index=0&lang.css`,
          url: styleUrl(),
          content: 'never read',
        },
      ]),
    }),
  };
  const runners: FakeRunner[] = [];
  const runnerFactoryCalls: number[] = [];

  // The style transform pops the schedule, and both the transform result
  // and the graph's cached code derive from the same current value — the
  // ownership proof (node under id and url holding the transform code)
  // stays real accounting, not a rubber stamp.
  let currentStyleCss = css.compiledCss;
  const styleCode = () => `const __vite__css = ${JSON.stringify(currentStyleCss)}`;
  const resolvedId = `/abs/proj/${ROUTE_COMPONENT}?astro&type=style&index=0&lang.css`;
  const node = {
    get transformResult() {
      return { code: styleCode() };
    },
  };

  const client = {
    transformRequest: async (url: string): Promise<{ code: string } | null> => {
      if (url === `/${ROUTE_COMPONENT}` && !css.pagePrimeBroken)
        return { code: 'export default {}' };
      if (url === styleUrl()) {
        styleTransformCount += 1;
        currentStyleCss = css.scheduled.shift() ?? css.compiledCss;
        css.onStyleTransform?.();
        return { code: styleCode() };
      }
      return null;
    },
    moduleGraph: {
      getModuleById: (id: string): unknown => (id === resolvedId ? node : undefined),
      getModuleByUrl: async (url: string): Promise<unknown> => (url === styleUrl() ? node : null),
    },
    pluginContainer: { resolveId: async () => ({ id: resolvedId }) },
  };

  const server: ViteServerLike = {
    environments: {
      ssr: {
        moduleGraph: { getModuleById: () => null, getModuleByUrl: () => null },
        pluginContainer: { resolveId: async () => null },
        hot: { api: { outsideEmitter: emitter } },
      },
      client,
    },
    watcher: {
      on: (event: string, listener: (...args: never[]) => void) => {
        watcher.on(event, listener as (...args: unknown[]) => void);
        return watcher;
      },
    },
    close: async () => {},
  };
  const seams: ProjectRuntimeSeams = {
    certifiedPair: { astro: '7.2.10', vite: '8.2.2' },
    projectRoot,
    getViteConfig: () => async () => ({}),
    vite: {
      createServer: async () => server,
      createServerModuleRunner: () => {
        runnerFactoryCalls.push(runnerFactoryCalls.length + 1);
        const runner = new FakeRunner(emitter, options.runnerBehavior ?? {}, async () => {
          css.onDevCssImport?.();
          return devCssImportRef.current();
        });
        runners.push(runner);
        return runner;
      },
    },
    getDevCSSModuleName: (componentId: string) => `virtual:astro:dev-css:${componentId}`,
  };

  Object.assign(harness, {
    server,
    seams,
    projectRoot,
    watcher,
    hotEmitter: emitter,
    css,
    runners,
    runnerFactoryCalls,
    setDevCssImport: (impl: () => Promise<unknown>) => {
      devCssImportRef.current = impl;
    },
    fireWatcherChange: (relativeFile: string) => {
      watcher.emit('change', join(projectRoot, relativeFile));
    },
    editScopedSelector: async (next: string) => {
      await rewriteStyleBlock(projectRoot, (block) =>
        block.replace(`  ${FIXTURE_SCOPED_SELECTOR} {`, `  ${next} {`),
      );
    },
    replaceStyleBlock: async (rules: readonly string[]) => {
      await rewriteStyleBlock(projectRoot, () =>
        ['<style>', ...rules.map((rule) => `  ${rule} { color: #1e293b; }`), '</style>'].join('\n'),
      );
    },
    dispose: async () => {
      await rm(projectRoot, { recursive: true, force: true });
    },
  } satisfies ConvergenceHarness);
  return harness;
}

/** Rewrites the fixture page's `<style>` block through `transform`. */
async function rewriteStyleBlock(
  projectRoot: string,
  transform: (block: string) => string,
): Promise<void> {
  const page = join(projectRoot, ROUTE_COMPONENT);
  const contents = await readFile(page, 'utf8');
  const match = contents.match(/<style>[\s\S]*?<\/style>/);
  if (match === null) throw new Error('the fixture page carries no style block to rewrite');
  await writeFile(page, contents.replace(match[0], transform(match[0])), 'utf8');
}
