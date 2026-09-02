import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routesFixtureSchema } from '../../../../e2e/behavior-contracts/schema/inspection-contract.ts';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import { createRoutesInspector } from '../../astro-project-adapter/routes/routes-inspection';
import { type FakeRunnerOptions, fakeComposition, fixtureRouteModules } from './fixture-seams';

/**
 * The routes inspection surface (#229 focused test): the composed pass —
 * certified seam read, typed projection, managed enumeration, fresh
 * runner per pass — over a seam-layer composition stand-in (#225 idiom:
 * the behavior layer is never faked as a compatibility claim; the
 * certification suite proves the real pair). Parity is judged against the
 * frozen routes corpus, the revision is monotonic and stands still for
 * rejected passes, abort rejects with the caller's reason, and the
 * result leaks no raw module, path, or runner field.
 */

interface CorpusRoute {
  readonly pattern: string;
}

async function corpusRoutes(): Promise<CorpusRoute[]> {
  const corpus = JSON.parse(
    await readFile(
      join(process.cwd(), 'e2e', 'behavior-contracts', 'inspection', 'routes.json'),
      'utf8',
    ),
  ) as { routes: CorpusRoute[] };
  return corpus.routes;
}

function inspector(
  options: FakeRunnerOptions = {},
  create: { readonly waitTimeoutMs?: number } = {},
) {
  const harness = fakeComposition(options);
  return {
    harness,
    inspector: createRoutesInspector({ composition: harness.composition, ...create }),
  };
}

describe('createRoutesInspector.inspect', () => {
  it('returns the frozen corpus payload — static and dynamic routes, renders included', async () => {
    const { inspector: routesInspector } = inspector();
    const result = await routesInspector.inspect();
    const corpus = await corpusRoutes();
    const byPattern = new Map(result.routes.map((route) => [route.pattern, route]));
    expect([...byPattern.keys()].sort()).toEqual(corpus.map((route) => route.pattern).sort());
    for (const route of corpus) {
      expect(byPattern.get(route.pattern)).toEqual(route);
    }
    // Contract-shaped: the payload validates against the frozen fixture
    // schema once envelope-stamped (the wire layer's stamp, mirrored).
    routesFixtureSchema.parse({
      contractVersion: '1.0.0',
      kind: 'routes',
      routes: result.routes,
    });
  });

  it('leaks no raw module, path, or runner field — plain payload data only', async () => {
    const { inspector: routesInspector } = inspector();
    const result = await routesInspector.inspect();
    expect(Object.keys(result).sort()).toEqual(['revision', 'routes']);
    for (const route of result.routes) {
      expect(Object.keys(route).sort()).toEqual(
        expect.arrayContaining(['pattern', 'segments', 'params', 'rendering']),
      );
      expect(Object.keys(route)).not.toContain('component');
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('carries a monotonic revision — one fresh runner per pass, closed every time', async () => {
    const { harness, inspector: routesInspector } = inspector();
    const first = await routesInspector.inspect();
    const second = await routesInspector.inspect();
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(harness.runners).toHaveLength(2);
    expect(harness.runners.every((runner) => runner.isClosed())).toBe(true);
    expect(harness.emitter.listenerCount('send')).toBe(0);
  });

  it('fails closed on an unknown virtual-route export shape, without ticking the revision', async () => {
    const config: FakeRunnerOptions = { virtualRoutesExport: {} };
    const { harness, inspector: routesInspector } = inspector(config);
    const rejection = await routesInspector.inspect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    expect((rejection as AdapterError).code).toBe('seam-rejected');
    // The fresh-runner discipline holds on the failure path too.
    expect(harness.runners[0]?.isClosed()).toBe(true);
    // The seam recovers (the fake reads its export per pass): the next
    // completed pass is revision 1 — a rejected pass never ticked it.
    (config as { virtualRoutesExport?: unknown }).virtualRoutesExport = undefined;
    const recovered = await routesInspector.inspect();
    expect(recovered.revision).toBe(1);
  });

  it('rejects with the caller reason when pre-aborted — revision untouched, runner discipline intact', async () => {
    const { harness, inspector: routesInspector } = inspector();
    const controller = new AbortController();
    controller.abort('lifecycle-stop');
    await expect(routesInspector.inspect({ signal: controller.signal })).rejects.toBe(
      'lifecycle-stop',
    );
    const next = await routesInspector.inspect();
    expect(next.revision).toBe(1);
    // The aborted pass created no runner at all; the completed one closed its own.
    expect(harness.runners).toHaveLength(1);
    expect(harness.runners[0]?.isClosed()).toBe(true);
  });

  it('contains an enumeration failure as unknown renders — the pass still completes', async () => {
    const modules = new Map(fixtureRouteModules()).set('src/pages/blog/[slug].astro', {
      getStaticPaths: () => {
        throw new Error('boom');
      },
    });
    const { inspector: routesInspector } = inspector({ modules });
    const result = await routesInspector.inspect();
    expect(result.revision).toBe(1);
    const slug = result.routes.find((route) => route.pattern === '/blog/[slug]');
    expect(slug).toBeDefined();
    expect(slug).not.toHaveProperty('renders');
    expect(result.routes.find((route) => route.pattern === '/blog/[...slug]')?.renders).toEqual([
      '2024/post',
      '2025/release-notes',
      'hello-builder',
    ]);
  });

  it('fails the pass closed when the metadata read hangs past its bound', async () => {
    const { harness, inspector: routesInspector } = inspector(
      { hangingVirtualRoutesImport: true },
      { waitTimeoutMs: 20 },
    );
    const rejection = await routesInspector.inspect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('exceeded its per-wait bound');
    // The hung pass still closed its runner — no residue into the next pass.
    expect(harness.runners[0]?.isClosed()).toBe(true);
  });

  it('rejects promptly with the caller reason when aborted during the metadata read', async () => {
    // The virtual-routes import never settles; the abort fires 10 ms in,
    // while the per-wait bound sits at 3 s — only the abort race can
    // reject this pass, and it must not wait for the hung import.
    const controller = new AbortController();
    const { harness, inspector: routesInspector } = inspector(
      { hangingVirtualRoutesImport: true },
      { waitTimeoutMs: 3_000 },
    );
    setTimeout(() => controller.abort('metadata-abort'), 10);
    await expect(routesInspector.inspect({ signal: controller.signal })).rejects.toBe(
      'metadata-abort',
    );
    expect(harness.runners[0]?.isClosed()).toBe(true);
    expect(harness.runners[0]?.importedIds).toEqual(['virtual:astro:routes']);
  });
});
