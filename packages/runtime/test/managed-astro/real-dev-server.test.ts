import { existsSync } from 'node:fs';
import { cp, mkdir, realpath, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { managedDevServerPlan } from '../../project-plane/managed-astro/dev-server.ts';
import { minimalChildEnv } from '../../project-plane/supervision/exact-child.ts';
import {
  createProjectPlaneSupervisor,
  type ProjectPlaneSupervisor,
} from '../../project-plane/supervision/plane-supervisor.ts';
import { cleanupScratch, freePort, makeScratch } from './lane-harness.ts';

// @vitest-environment node — boots the real astro dev server as a real child; no DOM.
/**
 * The managed dev server is REAL (#231, ADR-0005 "Real configuration and
 * duplicate hooks"): the supervisor's managed-Astro sibling boots the
 * canonical fixture's OWN `astro dev` — resolved from the project's
 * installation, cwd the canonical root — and its readiness means the
 * project's real configuration executed: the served index page carries
 * the fixture's real content-collection entry and real scoped-style
 * output (`data-astro-cid-*` under the default attribute strategy).
 *
 * The fixture's SOURCES are copied (with the installation symlinked in),
 * so the project-root caches the dev server writes (`.astro/`, `dist/`)
 * land in the copy, never in the tracked fixture. The symlink does NOT
 * isolate the installation's own caches: Vite's dev cache under
 * `node_modules/.vite/` writes back through the symlink into the shared
 * installation — tolerated because those cache directories are
 * hash-namespaced per project root and config, so this copy's cache
 * cannot collide with the readiness legs' builds of the fixture itself
 * in the same vitest run. The zero-injection guarantee holds either
 * way; this lane never edits the tracked fixture.
 */

const FIXTURE = fileURLToPath(new URL('../../../../e2e/fixture/', import.meta.url));
const STAND_IN_WORKER = fileURLToPath(new URL('./stand-in-worker.js', import.meta.url));

const supervisors: ProjectPlaneSupervisor[] = [];

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  await cleanupScratch();
});

/** Copies the tracked fixture's sources minus its installation, build output, and caches; links the installation back in. */
async function stagedFixtureCopy(): Promise<string> {
  const copy = join(await makeScratch('astroix-real-'), 'project');
  await cp(FIXTURE, copy, {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      return (
        name !== 'node_modules' && name !== 'dist' && name !== '.astro' && !name.startsWith('.')
      );
    },
  });
  await symlink(join(FIXTURE, 'node_modules'), join(copy, 'node_modules'), 'dir');
  return copy;
}

describe("the real managed Astro dev server as the supervisor's sibling", () => {
  it("boots the project's own dev server over its real configuration and stops it cleanly", async () => {
    const copy = await stagedFixtureCopy();
    const port = await freePort();
    const markerDir = join(copy, '..', 'markers');
    await mkdir(markerDir);

    const plan = await managedDevServerPlan({ projectRoot: copy, port });
    expect(plan.cwd).toBe(await realpath(copy)); // canonical: the realpath'd root, never the alias spelling
    expect(plan.argv.slice(1)).toEqual(['dev', '--port', String(port), '--host', '127.0.0.1']);
    // The lane's precondition, same contract as the readiness legs: the
    // canonical fixture is installed (npm install in e2e/fixture).
    expect(
      existsSync(join(FIXTURE, 'node_modules', 'astro', 'package.json')),
      'e2e/fixture must be installed for the managed-dev-server lane (npm install there)',
    ).toBe(true);

    const supervisor = createProjectPlaneSupervisor({
      worker: {
        executable: process.execPath,
        argv: [STAND_IN_WORKER, JSON.stringify({ markerDir })],
        cwd: plan.cwd,
        env: minimalChildEnv(process.env),
        ipc: true,
        execArgv: [],
      },
      managedAstro: plan,
      devServerPort: port,
      startupTimeoutMs: 60_000,
      stopTimeoutMs: 5000,
      termGraceMs: 5000,
      killReapMs: 2000,
    });
    supervisors.push(supervisor);

    // Ready = the real dev server answered 200 on its loopback origin.
    await supervisor.ready;
    expect(supervisor.state).toBe('running');

    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.ok).toBe(true);
    const html = await page.text();
    // Real project configuration execution: the real content-collection
    // entry's fields and real scoped-style output (the default attribute
    // strategy's data-astro-cid attributes) — no synthetic config could
    // produce these.
    expect(html).toContain('Astroix fixture');
    expect(html).toContain('A synthetic Astro 7 project exercising the builder e2e loop.');
    expect(html).toContain('data-astro-cid-');

    const report = await supervisor.stop();
    expect(report).toMatchObject({ reason: 'stopped', outcome: 'complete', failures: [] });
    expect(report.accounting.killEscalations).toEqual([]); // astro exits on SIGTERM — the E1 observation
  }, 90_000);
});
