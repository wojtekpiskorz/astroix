import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The web lane's test-owned staging (#240's migration policy: "configure
 * projects through test-owned registry setup" — the canonical fixture
 * stays injection-free): one scratch root carrying two staged copies of
 * the canonical fixture (sources copied, installation symlinked back —
 * the managed-astro lane's discipline, so dev-server caches land in the
 * copies, never in the tracked fixture), one deliberately-broken
 * project root (no installation to resolve — the sanitized
 * failed-activation leg's cause), the isolated registry directory, and
 * the env file the web host boots from. Nothing here registers through
 * the browser: registration is a control-plane-side boot input, the
 * native directory grant's stand-in.
 */

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = join(WORKSPACE_ROOT, 'e2e', 'fixture');
// The scratch root lives in the OS temp dir, NOT under test-results —
// Playwright clears its own output directory at startup, which would
// delete the staged env file between config load and the webServer
// spawn. Disposed by the lane's teardown.
const SCRATCH_ROOT = join(tmpdir(), 'astroix-web-240');
const ENV_FILE = join(SCRATCH_ROOT, 'web-host.env');

/** The web lane's fixed port (≥4426, per the lane-port doctrine; never 4314/4313 outside CI). */
export const WEB_LANE_PORT = 4426;

export interface WebLaneStage {
  readonly envFile: string;
  readonly launcherUrl: string;
  teardown(): Promise<void>;
}

/** Stages the lane: two fixture copies, one broken root, the isolated registry, the env file. */
export async function stageWebLane(): Promise<WebLaneStage> {
  await rm(SCRATCH_ROOT, { recursive: true, force: true });
  const registry = join(SCRATCH_ROOT, 'registry');
  const projectA = await stagedFixtureCopy('project-a');
  const projectB = await stagedFixtureCopy('project-b');
  const broken = join(SCRATCH_ROOT, 'broken');
  await mkdir(registry, { recursive: true });
  await mkdir(broken, { recursive: true });
  const launcherUrl = `http://launcher.localhost:${WEB_LANE_PORT}/__astroix/app/`;
  const env = [
    `ASTROIX_WEB_PORT=${WEB_LANE_PORT}`,
    `ASTROIX_WEB_REGISTRY_DIR=${registry}`,
    `ASTROIX_WEB_REGISTER=${projectA}:${projectB}:${broken}`,
    // The E7 carried warning, materialized: a CI cold boot (fresh vite
    // optimize under a shared runner) can exceed the 30 s production
    // startup deadline — the test host budgets 120 s through the
    // composition's env seam, the production default stays untouched.
    'ASTROIX_WEB_PLANE_STARTUP_MS=120000',
  ].join('\n');
  await mkdir(SCRATCH_ROOT, { recursive: true });
  await writeFile(ENV_FILE, `${env}\n`, 'utf8');
  return {
    envFile: ENV_FILE,
    launcherUrl,
    teardown: async () => {
      await rm(SCRATCH_ROOT, { recursive: true, force: true });
    },
  };
}

/** Copies the tracked fixture's sources minus installation, output, and caches; links the installation back in. */
async function stagedFixtureCopy(name: string): Promise<string> {
  const copy = join(SCRATCH_ROOT, name);
  await mkdir(copy, { recursive: true });
  await cp(FIXTURE, copy, {
    recursive: true,
    filter: (source) => {
      const entry = basename(source);
      return (
        entry !== 'node_modules' && entry !== 'dist' && entry !== '.astro' && !entry.startsWith('.')
      );
    },
  });
  await symlink(join(FIXTURE, 'node_modules'), join(copy, 'node_modules'), 'dir');
  return copy;
}
