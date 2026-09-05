import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
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
 *
 * #350 (concurrent lanes): the scratch root is PER-INVOCATION by
 * default — `stageWebLane()` mints a fresh nonce root and publishes it
 * through `ASTROIX_WEB_E2E_SCRATCH` — so two `npm run test:e2e`
 * invocations can never stage (or `rm -rf`) into each other's root
 * mid-battery. Both knobs also take an explicit env override (the
 * steering convention: one exclusive port + scratch per lane, like the
 * legacy fixture trio); the port default stays the fixed 4426, so CI
 * (one runner, no envs) is untouched.
 */

// dirname(fileURLToPath(...)), never `new URL('../../..', import.meta.url)`:
// under vitest's vite transform the URL form is statically rewritten to a
// dev-server asset URL when the target stays inside the vite root (this
// module is exactly three levels deep) — the path form is identical under
// playwright's config loader and vitest alike.
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE = join(WORKSPACE_ROOT, 'e2e', 'fixture');
// The scratch root lives in the OS temp dir, NOT under test-results —
// Playwright clears its own output directory at startup, which would
// delete the staged env file between config load and the webServer
// spawn. Disposed by the lane's teardown. The per-invocation default is
// minted inside stageWebLane() (PID + random nonce); an explicit
// ASTROIX_WEB_E2E_SCRATCH wins over the minted root.

export const WEB_E2E_PORT_ENV = 'ASTROIX_WEB_E2E_PORT';
export const WEB_E2E_SCRATCH_ENV = 'ASTROIX_WEB_E2E_SCRATCH';

const DEFAULT_WEB_LANE_PORT = 4426;

/** Resolves the lane's port from the environment; fails loudly on garbage instead of half-binding. */
function resolveWebLanePort(): number {
  const raw = process.env[WEB_E2E_PORT_ENV];
  if (raw === undefined || raw === '') {
    return DEFAULT_WEB_LANE_PORT;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `stage-e2e: ${WEB_E2E_PORT_ENV} must be an integer TCP port 1-65535, got "${raw}"`,
    );
  }
  const port = Number.parseInt(raw, 10);
  // The range checks are NaN-transparent (both comparisons false), so the
  // regex above is the ONLY format rejection — if it is ever dropped as
  // "redundant", `abc` parses to NaN and surfaces much later as a dead URL.
  if (port < 1 || port > 65535) {
    throw new Error(
      `stage-e2e: ${WEB_E2E_PORT_ENV} must be an integer TCP port 1-65535, got "${raw}"`,
    );
  }
  return port;
}

/** The web lane's port (default 4426, ≥4426 per the lane-port doctrine; never 4314/4313 outside CI). */
export const WEB_LANE_PORT = resolveWebLanePort();

/** The root this module instance last minted — so its own publication is never mistaken for an override. */
let mintedRoot: string | undefined;

/**
 * Resolves this staging's scratch root: an explicit env override is
 * honored as given (reused verbatim — deterministic, user-directed);
 * otherwise a fresh nonce root is minted per staging, so no invocation
 * ever stages into — or `rm -rf`s — another's root.
 */
function resolveScratchRoot(): string {
  const fromEnv = process.env[WEB_E2E_SCRATCH_ENV];
  if (fromEnv !== undefined && fromEnv !== '' && fromEnv !== mintedRoot) {
    if (!isAbsolute(fromEnv)) {
      throw new Error(
        `stage-e2e: ${WEB_E2E_SCRATCH_ENV} must be an absolute path, got "${fromEnv}"`,
      );
    }
    return fromEnv;
  }
  mintedRoot = join(tmpdir(), `astroix-web-e2e-${process.pid}-${randomUUID().slice(0, 8)}`);
  return mintedRoot;
}

/**
 * The staged copies' root (exported for the specs that assert against
 * the managed copies themselves — #242's zero-injection snapshots and
 * its disposable-copy HMR mutations; the staging layout is this
 * module's own contract, so the seam is too). Answers from the root
 * `stageWebLane()` published to the environment — the only channel that
 * crosses the process boundary between the config-load staging and the
 * spec workers — and fails closed when no staging has run.
 */
export function stagedCopyRoot(name: string): string {
  const root = process.env[WEB_E2E_SCRATCH_ENV];
  if (root === undefined || root === '') {
    throw new Error(
      `stage-e2e: the scratch root is unknown — ${WEB_E2E_SCRATCH_ENV} is unset. ` +
        'It is minted and published by stageWebLane() at playwright config load; ' +
        'stagedCopyRoot only answers inside a run whose staging has run (#350).',
    );
  }
  return join(root, name);
}

/**
 * The warm-activation memo's path OUTSIDE the scratch root, keyed by it
 * (#422, trap b): the invocation identity without the wiped directory.
 * The root is disposable by design: the staging wipes it on every real
 * (re)stage, and Playwright re-evaluates the config in every worker —
 * before the config's worker guard (#422), a replacement worker's
 * re-evaluation wiped the root MID-INVOCATION after any failed leg (the
 * memo died exactly when the warm shape needed it, and the live plane's
 * staged files vanished under it). Outside the root the memo survives
 * every wipe, and its keys are epoch-scoped, so a stale file from a
 * previous invocation over an explicit (reused) scratch root can never
 * match the new control plane's epoch. The derivation is homed here,
 * beside `stagedCopyRoot` — the root contract it derives from is this
 * module's own (#433 round 2: it was re-derived in `spec-helpers.ts`
 * from the other side of the env var), and the lane's teardown removes
 * the file alongside the root, so nothing accumulates across
 * invocations. Fails loudly when no staging has run.
 */
export function settleMemoPath(): string {
  const root = process.env[WEB_E2E_SCRATCH_ENV];
  if (root === undefined || root === '') {
    throw new Error(
      `stage-e2e: ${WEB_E2E_SCRATCH_ENV} is unset — the warm-activation memo is keyed by the staging's scratch root (#422)`,
    );
  }
  const tag = root.split(/[\\/]/).filter(Boolean).pop();
  if (tag === undefined) throw new Error(`stage-e2e: malformed scratch root "${root}" (#422)`);
  return join(dirname(root), `.astroix-${tag}-settle-generations.json`);
}

export interface WebLaneStage {
  readonly envFile: string;
  readonly launcherUrl: string;
  teardown(): Promise<void>;
}

/** Stages the lane: two fixture copies, one broken root, the isolated registry, the env file. */
export async function stageWebLane(): Promise<WebLaneStage> {
  const scratchRoot = resolveScratchRoot();
  // Publish the invocation's root to the descendants that import this
  // module independently (spec workers, the global teardown) — they must
  // resolve THIS invocation's root, and the environment is inherited by
  // every process the runner spawns after config load.
  process.env[WEB_E2E_SCRATCH_ENV] = scratchRoot;
  await rm(scratchRoot, { recursive: true, force: true });
  const registry = join(scratchRoot, 'registry');
  const projectA = await stagedFixtureCopy(scratchRoot, 'project-a');
  const projectB = await stagedFixtureCopy(scratchRoot, 'project-b');
  const broken = join(scratchRoot, 'broken');
  await mkdir(registry, { recursive: true });
  await mkdir(broken, { recursive: true });
  const launcherUrl = `http://launcher.localhost:${WEB_LANE_PORT}/__astroix/app/`;
  const env = [
    `ASTROIX_WEB_PORT=${WEB_LANE_PORT}`,
    `ASTROIX_WEB_REGISTRY_DIR=${registry}`,
    `ASTROIX_WEB_REGISTER=${projectA}:${projectB}:${broken}`,
  ].join('\n');
  const envFile = join(scratchRoot, 'web-host.env');
  await mkdir(scratchRoot, { recursive: true });
  await writeFile(envFile, `${env}\n`, 'utf8');
  return {
    envFile,
    launcherUrl,
    teardown: async () => {
      await rm(scratchRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Copies the tracked fixture's sources minus installation, output, and
 * caches; links the installation back in. Exported for the lanes that
 * stage the same disposable-copy discipline outside this module's own
 * staging (the real-Electron CSS lane's fixture copy — the second
 * consumer; the discipline stays owned here, never re-encoded).
 */
export async function stagedFixtureCopy(scratchRoot: string, name: string): Promise<string> {
  const copy = join(scratchRoot, name);
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
