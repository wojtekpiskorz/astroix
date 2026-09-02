import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Certification staging (#225): builds a disposable real Astro project —
 * a temp-copy of the canonical plain fixture's sources (`e2e/fixture`,
 * the byte-stable contract surface, never edited) under an exact-pinned
 * manifest (`astro@7.2.10 + vite@8.2.2`, the certified pair — exact pins
 * for the certification fixture only) — installs it with npm, and
 * provides the managed-dev-server leg for the duplicate-hook proofs.
 *
 * Everything here is certification machinery: temp dirs, real installs,
 * bounded waits, guaranteed cleanup. A failing run keeps its workspace
 * and prints the path (the #206 evidence discipline); a passing run
 * deletes it.
 */

const CERTIFICATION_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CERTIFICATION_DIR, '..', '..', '..', '..');
const CANONICAL_FIXTURE = join(REPO_ROOT, 'e2e', 'fixture');
const TEMPLATE_INTEGRATION = join(CERTIFICATION_DIR, 'observable-integration.mjs');

/** The certified exact pins — the only versions the certification ever installs. */
export const CERTIFIED_ASTRO_PIN = '7.2.10';
export const CERTIFIED_VITE_PIN = '8.2.2';

/** The scoped-style strategy variants the corpora freeze (attribute default, where configured). */
export type CertificationStrategy = 'attribute' | 'where';

export interface StagedProject {
  readonly root: string;
  readonly hookLog: string;
  readonly exclusivePath: string;
}

/** One observed `astro:config:setup` execution from the fixture's integration log. */
export interface HookObservation {
  readonly command: string;
  readonly hook: string;
  readonly mode: string;
  readonly pid: number;
  readonly processLocalConfigSetupCount: number;
}

/**
 * Reads the observable integration's append-only log. A missing log is
 * the normal pre-boot state (the managed-server wait polls before the
 * first execution lands) and reads as zero observations; every other
 * failure — an unreadable file, a corrupt line — propagates, so a broken
 * harness fails named instead of masquerading as "no hook executed"
 * (#129/#206 evidence discipline).
 */
export async function readHookLog(hookLog: string): Promise<HookObservation[]> {
  let contents: string;
  try {
    contents = await readFile(hookLog, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as HookObservation);
}

/**
 * Stages the disposable certification project: canonical fixture sources
 * + tsconfig, the exact-pinned manifest, the observable integration, and
 * a generated `astro.config.mjs` with the phase's strategy and mode
 * baked in. Does NOT install — `installProject` does, so stub-manifest
 * legs can stage cheaply.
 */
export async function stageProject(input: {
  readonly strategy: CertificationStrategy;
  readonly mode: 'append' | 'exclusive';
}): Promise<StagedProject> {
  const root = await mkdtemp(join(tmpdir(), 'astroix-adapter-certification-'));
  const hookLog = join(root, 'certification-hook.log');
  const exclusivePath = join(root, 'certification-exclusive-claim');
  await copyTree(join(CANONICAL_FIXTURE, 'src'), join(root, 'src'));
  await copyFile(join(CANONICAL_FIXTURE, 'tsconfig.json'), join(root, 'tsconfig.json'));
  await copyFile(TEMPLATE_INTEGRATION, join(root, 'observable-integration.mjs'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'astroix-adapter-certification-fixture',
        private: true,
        type: 'module',
        dependencies: { astro: CERTIFIED_ASTRO_PIN, vite: CERTIFIED_VITE_PIN },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, 'astro.config.mjs'),
    astroConfigSource(input.strategy, input.mode, { hookLog, exclusivePath }),
  );
  return { root, hookLog, exclusivePath };
}

/**
 * Installs a staged project with npm (real install of the exact pins).
 * Prints captured npm output into the rejection so failures diagnose.
 */
export async function installProject(projectRoot: string): Promise<void> {
  const outcome = await run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--loglevel=error'],
    projectRoot,
  );
  if (outcome.code !== 0) {
    throw new Error(
      `npm install failed in the certification project (exit ${outcome.code}):\n${outcome.output}`,
    );
  }
}

export interface ManagedDevObservation {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}

/**
 * The managed-dev-server leg of the duplicate-hook proofs: boots the
 * project's own `astro dev` as a child (the production duplicate of the
 * composition config execution), waits until its integration observed a
 * config execution from its own pid, then stops it with SIGTERM (never
 * SIGKILL first — a clean stop is part of the observation) and reports
 * the exit.
 */
export async function runManagedDevServer(input: {
  readonly projectRoot: string;
  readonly hookLog: string;
  readonly timeoutMs?: number;
}): Promise<ManagedDevObservation> {
  const port = await freePort();
  const child = spawn(
    join(input.projectRoot, 'node_modules', '.bin', 'astro'),
    ['dev', '--port', String(port), '--host', '127.0.0.1'],
    {
      cwd: input.projectRoot,
      env: minimalChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  if (child.pid === undefined) {
    throw new Error(
      'the managed dev server child spawned without a pid — cannot correlate hook observations',
    );
  }
  const pid = child.pid;
  try {
    const observedOwn = await waitFor(
      async () => (await readHookLog(input.hookLog)).some((observation) => observation.pid === pid),
      input.timeoutMs ?? 90_000,
    );
    if (!observedOwn) {
      throw new Error(
        `the managed dev server observed no config execution within its budget; output so far:\n${output}`,
      );
    }
    // Readiness, not just config execution: the index page answering 200
    // means the content layer has synced its data store — the store the
    // composition's astro:content reads (the #206 managed-first order).
    const served = await waitFor(
      async () =>
        fetch(`http://127.0.0.1:${port}/`)
          .then((response) => response.ok)
          .catch(() => false),
      input.timeoutMs ?? 90_000,
    );
    if (!served) {
      throw new Error(
        `the managed dev server never served its index page within its budget; output so far:\n${output}`,
      );
    }
  } finally {
    child.kill('SIGTERM');
  }
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal });
    });
  });
  // A clean stop is SIGTERM answered by exit 0 or the conventional 143
  // (128+SIGTERM — astro's signal handling exits by code, signal null).
  if (exit.code !== 0 && exit.code !== 143 && exit.signal !== 'SIGTERM') {
    throw new Error(
      `the managed dev server exited uncleanly (code ${exit.code}, signal ${exit.signal}):\n${output}`,
    );
  }
  return { pid, exitCode: exit.code, exitSignal: exit.signal };
}

function astroConfigSource(
  strategy: CertificationStrategy,
  mode: 'append' | 'exclusive',
  paths: { hookLog: string; exclusivePath: string },
): string {
  return `import { defineConfig } from 'astro/config';
import { observableIntegration } from './observable-integration.mjs';

// Generated certification config (#225): the phase's scoped-style strategy
// and duplicate-hook mode are baked in so each phase is a static, real
// project config — never env-dependent.
export default defineConfig({
  ${strategy === 'where' ? "scopedStyleStrategy: 'where'," : ''}
  integrations: [
    observableIntegration(${JSON.stringify({ mode, hookLog: paths.hookLog, exclusivePath: paths.exclusivePath })}),
  ],
});
`;
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) await copyFile(source, target);
  }
}

/**
 * A deliberately minimal, whitelisted child environment (ADR-0005
 * discipline): the certification host's own environment is NOT inherited —
 * vitest's presence (VITEST_*, NODE_ENV, VITE_* vars) leaks into the
 * managed project's processes and changes astro's serving behavior
 * (observed: a dev server 404ing its index route under a vitest-inherited
 * env). Children get only what a project process needs.
 */
function minimalChildEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    ASTRO_TELEMETRY_DISABLED: '1',
    CI: '1',
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) reject(new Error('no ephemeral port'));
        else resolve(port);
      });
    });
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: minimalChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, output }));
  });
}
