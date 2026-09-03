import { existsSync, readlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The web lane staging's exclusive-use laws (#350), pinned where the
 * seam allows: the port and scratch-root env overrides are honored; the
 * default scratch root is per-invocation (a fresh nonce every staging,
 * never the one fixed root whose config-load `rm -rf` deleted a live
 * lane's registry mid-battery); the scratch root is published through
 * the environment so spec workers and teardown resolve the SAME
 * invocation's root; `stagedCopyRoot` fails closed before any staging
 * ran; and the playwright config pins the loud-fail law
 * (`reuseExistingServer: false` — a busy port must fail, never silently
 * drive a foreign control plane). The module resolves its knobs from
 * the environment at import, so every leg re-imports it under a
 * controlled environment — BOTH knobs, always: a concurrent lane's
 * ambient `ASTROIX_WEB_E2E_PORT` (the AGENTS.md steering export) must
 * never leak into an assertion, and a garbage ambient must never reject
 * the import under test.
 */

const PORT_ENV = 'ASTROIX_WEB_E2E_PORT';
const SCRATCH_ENV = 'ASTROIX_WEB_E2E_SCRATCH';
const DEFAULT_PORT = 4426;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'e2e', 'fixture');

const savedEnv: Record<string, string | undefined> = {};

function freshStageE2e(): Promise<typeof import('./stage-e2e.ts')> {
  vi.resetModules();
  return import('./stage-e2e.ts');
}

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
});

afterAll(() => {
  vi.resetModules();
});

function controlEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('the web lane port knob (#350)', () => {
  it('defaults to the fixed 4426 when the env is unset (CI untouched)', async () => {
    controlEnv(PORT_ENV, undefined);
    const stageE2e = await freshStageE2e();
    expect(stageE2e.WEB_LANE_PORT).toBe(DEFAULT_PORT);
  });

  it('honors the ASTROIX_WEB_E2E_PORT override', async () => {
    controlEnv(PORT_ENV, '4438');
    const stageE2e = await freshStageE2e();
    expect(stageE2e.WEB_LANE_PORT).toBe(4438);
  });

  it('fails loudly at import on a garbage port instead of half-binding', async () => {
    controlEnv(PORT_ENV, '4426x');
    await expect(freshStageE2e()).rejects.toThrow(/ASTROIX_WEB_E2E_PORT.*4426x/);
  });
});

describe('the scratch root knob (#350)', () => {
  // The staging legs copy the real fixture — real IO, seconds-scale cold
  // and more under machine load; vitest's 5s default timed one out at
  // 5001ms during a loaded gate run (observed twice), so they carry
  // explicit timeouts like the e2e batteries' real-IO legs.
  it('honors the ASTROIX_WEB_E2E_SCRATCH override and publishes it', {
    timeout: 30_000,
  }, async () => {
    controlEnv(PORT_ENV, undefined);
    controlEnv(SCRATCH_ENV, undefined);
    const scratch = await mkdtemp(join(tmpdir(), 'astroix-stage-e2e-test-'));
    controlEnv(SCRATCH_ENV, scratch);
    const stageE2e = await freshStageE2e();
    const stage = await stageE2e.stageWebLane();
    // Everything the lane touches lives under the override: the env
    // file, the registry, the broken root, the staged copies.
    expect(stage.envFile).toBe(join(scratch, 'web-host.env'));
    const envFile = await readFile(stage.envFile, 'utf8');
    expect(envFile).toContain(`ASTROIX_WEB_PORT=${DEFAULT_PORT}`);
    expect(envFile).toContain(`ASTROIX_WEB_REGISTRY_DIR=${join(scratch, 'registry')}`);
    expect(existsSync(join(scratch, 'project-a', 'package.json'))).toBe(true);
    expect(existsSync(join(scratch, 'project-b', 'package.json'))).toBe(true);
    expect(existsSync(join(scratch, 'broken'))).toBe(true);
    // The installation links back at the tracked fixture, never copies.
    expect(readlinkSync(join(scratch, 'project-a', 'node_modules'))).toBe(
      join(FIXTURE, 'node_modules'),
    );
    // The published root is what stagedCopyRoot answers with.
    expect(process.env[SCRATCH_ENV]).toBe(scratch);
    expect(stageE2e.stagedCopyRoot('project-a')).toBe(join(scratch, 'project-a'));
    await stage.teardown();
    expect(existsSync(scratch)).toBe(false);
  });

  it('mints a per-invocation nonce root by default — two stagings never share one', {
    timeout: 30_000,
  }, async () => {
    controlEnv(PORT_ENV, undefined);
    controlEnv(SCRATCH_ENV, undefined);
    const stageE2e = await freshStageE2e();
    const first = await stageE2e.stageWebLane();
    const firstRoot = process.env[SCRATCH_ENV];
    const second = await stageE2e.stageWebLane();
    const secondRoot = process.env[SCRATCH_ENV];

    expect(firstRoot).toBeDefined();
    expect(secondRoot).toBeDefined();
    expect(firstRoot).not.toBe(secondRoot);
    expect(firstRoot).not.toBe(join(tmpdir(), 'astroix-web-240'));
    // The one fixed scratch root whose config-load rm -rf could delete a
    // live lane's staging (#350's mechanism) is gone: every root is
    // fresh, namespaced, and under the OS temp dir.
    expect(firstRoot?.startsWith(join(tmpdir(), 'astroix-web-e2e-'))).toBe(true);
    expect(secondRoot?.startsWith(join(tmpdir(), 'astroix-web-e2e-'))).toBe(true);
    // The publication tracks the latest invocation — the workers of the
    // run this staging belongs to see THIS root.
    expect(stageE2e.stagedCopyRoot('project-a')).toBe(join(secondRoot as string, 'project-a'));

    await first.teardown();
    await second.teardown();
    expect(existsSync(firstRoot as string)).toBe(false);
    expect(existsSync(secondRoot as string)).toBe(false);
  });

  it('stagedCopyRoot fails closed when no staging has published a root', async () => {
    controlEnv(PORT_ENV, undefined);
    controlEnv(SCRATCH_ENV, undefined);
    const stageE2e = await freshStageE2e();
    expect(() => stageE2e.stagedCopyRoot('project-a')).toThrow(/ASTROIX_WEB_E2E_SCRATCH/);
  });
});

describe('the lane teardown (#350)', () => {
  it('removes the root the staging published', async () => {
    controlEnv(PORT_ENV, undefined);
    const scratch = await mkdtemp(join(tmpdir(), 'astroix-stage-e2e-test-'));
    await writeFile(join(scratch, 'web-host.env'), 'sentinel\n', 'utf8');
    controlEnv(SCRATCH_ENV, scratch);
    vi.resetModules();
    const teardown = (await import('./teardown-e2e.ts')).default;
    await teardown();
    expect(existsSync(scratch)).toBe(false);
  });

  it('is a no-op when no staging ran (nothing published)', async () => {
    controlEnv(PORT_ENV, undefined);
    controlEnv(SCRATCH_ENV, undefined);
    vi.resetModules();
    const teardown = (await import('./teardown-e2e.ts')).default;
    await expect(teardown()).resolves.toBeUndefined();
  });
});

describe('the playwright config pins the loud-fail law (#350)', () => {
  it('never reuses a server, and the port override flows end to end', {
    timeout: 30_000,
  }, async () => {
    const port = 4438;
    const scratch = await mkdtemp(join(tmpdir(), 'astroix-stage-e2e-test-'));
    controlEnv(PORT_ENV, String(port));
    controlEnv(SCRATCH_ENV, scratch);
    try {
      vi.resetModules();
      const config = (await import('../../../playwright.config.ts')).default;
      // This config declares ONE web server; the type allows the array
      // form, so take the single entry the assertions are about.
      const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
      // A busy port must fail loudly on this run's own spawn — never
      // silently drive whichever lane's server already answers.
      expect(webServer?.reuseExistingServer).toBe(false);
      expect(config.use?.baseURL).toBe(`http://launcher.localhost:${port}`);
      expect(webServer?.url).toBe(`http://launcher.localhost:${port}/__astroix/app/`);
      // The config-load staging (side effect of the import) landed under
      // the overridden root and port.
      const envFile = await readFile(join(scratch, 'web-host.env'), 'utf8');
      expect(envFile).toContain(`ASTROIX_WEB_PORT=${port}`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
