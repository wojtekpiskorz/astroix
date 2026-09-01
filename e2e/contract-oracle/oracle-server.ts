import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ORACLE_MAIN } from '../oracle.mjs';
import { MAIN_PORT } from '../ports.ts';

/**
 * Boot helper for the disposable inspection-contract oracles (#216): runs
 * the prep script (regenerate-on-setup — cleanup is rm-and-recreate, never
 * git), spawns `npm run dev` in the generated copy as its own process
 * group, polls the `/__astroix` API until the server answers, and tears the
 * whole group down deterministically on the way out (SIGTERM, then SIGKILL
 * — the group kill reaches npm→node→astro, no orphan dev servers).
 *
 * During the no-E2E interval (ADR-0010, amended 2026-09-01) Playwright
 * carries no webServers — the capture suite and the freeze spec boot their
 * evidence producers through this module instead.
 */

export type OracleKind = 'main' | 'where';

/** The where lane's port (#216): canonical default + env override for parallel local lanes. */
export const WHERE_PORT = Number(process.env.ASTROIX_E2E_WHERE_PORT || 4395);

/** Main oracle port — re-exported from the shared per-lane module (#120). */
export { MAIN_PORT };

const ROOT = process.cwd();

const PREP_SCRIPTS: Record<OracleKind, string> = {
  main: join('scripts', 'prepare-local-link.mjs'),
  where: join('e2e', 'contract-oracle', 'prepare-where-oracle.mjs'),
};

const ORACLE_DIRS: Record<OracleKind, string> = {
  main: join(ROOT, ORACLE_MAIN),
  where: join(ROOT, 'e2e', 'contract-oracle', '.oracle-where'),
};

const PORT_VARS: Record<OracleKind, string> = {
  main: 'ASTROIX_E2E_PORT',
  where: 'ASTROIX_E2E_WHERE_PORT',
};

/** Regenerate the oracle copy (prep scripts are the single authority on shape). */
async function prepareOracle(kind: OracleKind): Promise<string> {
  await run(join(ROOT, PREP_SCRIPTS[kind]), ROOT);
  return ORACLE_DIRS[kind];
}

function run(script: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited with ${code ?? 'signal'}`)),
    );
  });
}

/** Poll until the oracle's API answers — the boot gate every capture starts from. */
async function waitForApi(base: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/__astroix/routes`);
      if (response.ok) {
        await response.json();
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`oracle at ${base} never answered /__astroix/routes (${lastError})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kill the dev-server process group: TERM, grace, KILL — deterministic teardown. */
async function killGroup(pid: number, stderrTail: () => string): Promise<void> {
  const kill = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone — the teardown contract is "no survivor", satisfied
    }
  };
  kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
      await sleep(100);
    } catch {
      return;
    }
  }
  console.error(
    `[astroix] oracle dev server ignored SIGTERM — SIGKILL. stderr tail:\n${stderrTail()}`,
  );
  kill('SIGKILL');
}

/** Boot an oracle and run `use` against its base URL — the server never outlives the call. */
export async function withOracleServer<T>(
  kind: OracleKind,
  port: number,
  use: (handle: { base: string; dir: string }) => Promise<T>,
): Promise<T> {
  const dir = await prepareOracle(kind);
  const base = `http://localhost:${port}`;
  const child = spawn('npm', ['run', 'dev'], {
    cwd: dir,
    env: { ...process.env, [PORT_VARS[kind]]: String(port) },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (child.stderr === null) throw new Error('oracle dev server spawned without a stderr pipe');
  let tail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    tail = `${tail}${chunk.toString()}`.slice(-4000);
  });

  try {
    await waitForApi(base, 90_000);
    return await use({ base, dir });
  } finally {
    if (child.pid !== undefined) {
      await killGroup(child.pid, () => tail);
    }
  }
}
