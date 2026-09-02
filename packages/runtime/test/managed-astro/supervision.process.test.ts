import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { minimalChildEnv } from '../../project-plane/supervision/exact-child.ts';
import {
  createProjectPlaneSupervisor,
  type PlaneSupervisorOptions,
  type ProjectPlaneSupervisor,
  workerSpawnPlan,
} from '../../project-plane/supervision/plane-supervisor.ts';
import { cleanupScratch, freePort, makeScratch } from './lane-harness.ts';

// @vitest-environment node — spawns real children with real signals and sockets; no DOM.
/**
 * The #231 supervision process lane: the plane supervisor over REAL child
 * processes — the stand-in worker (E6's wire subset) and the stand-in dev
 * server (a real loopback socket) spawned through the same exact-child
 * spawn path production uses. Crash is terminal and never auto-restarts;
 * the graceful stop runs the ordered close (worker internals, sockets,
 * then terminate+reap both exact children); escalation and reap bounds
 * are exercised against children that really ignore or delay SIGTERM.
 */

const STAND_IN_WORKER = fileURLToPath(new URL('./stand-in-worker.js', import.meta.url));
const STAND_IN_DEV_SERVER = fileURLToPath(new URL('./stand-in-dev-server.js', import.meta.url));

interface Lane {
  readonly supervisor: ProjectPlaneSupervisor;
  readonly markerDir: string;
  readonly workerControlDir: string;
  readonly astroControlDir: string;
  readonly scratch: string;
}

const lanes: Lane[] = [];

afterEach(async () => {
  await Promise.allSettled(lanes.splice(0).map((lane) => lane.supervisor.stop()));
  await cleanupScratch();
});

interface LaneConfig {
  workerBehaviors?: Record<string, unknown>;
  devServer?: Record<string, unknown>;
  bounds?: Partial<
    Pick<
      PlaneSupervisorOptions,
      'startupTimeoutMs' | 'stopTimeoutMs' | 'termGraceMs' | 'killReapMs' | 'probeIntervalMs'
    >
  >;
  /** Overrides the whole environment both children spawn with (the spawn-discipline test). */
  env?: Record<string, string>;
  /** Overrides the project root both children run in (the shell-metacharacter test). */
  cwd?: string;
  workerSnapshotPath?: string;
  astroSnapshotPath?: string;
}

async function startLane(config: LaneConfig = {}): Promise<Lane> {
  const scratch = await makeScratch('astroix-sup-');
  const markerDir = join(scratch, 'markers');
  const workerControlDir = join(scratch, 'worker-control');
  const astroControlDir = join(scratch, 'astro-control');
  await Promise.all([mkdir(markerDir), mkdir(workerControlDir), mkdir(astroControlDir)]);
  const cwd = config.cwd ?? scratch;
  const env = config.env ?? minimalChildEnv(process.env);
  const port = await freePort();
  const workerArgument = JSON.stringify({
    markerDir,
    controlDir: workerControlDir,
    behaviors: config.workerBehaviors ?? {},
    ...(config.workerSnapshotPath ? { snapshotPath: config.workerSnapshotPath } : {}),
  });
  const devServerArgument = JSON.stringify({
    markerDir,
    controlDir: astroControlDir,
    port,
    ...config.devServer,
    ...(config.astroSnapshotPath ? { snapshotPath: config.astroSnapshotPath } : {}),
  });
  const supervisor = createProjectPlaneSupervisor({
    worker: {
      executable: process.execPath,
      argv: [STAND_IN_WORKER, workerArgument],
      cwd,
      env,
      ipc: true,
      execArgv: [],
    },
    managedAstro: {
      executable: process.execPath,
      argv: [STAND_IN_DEV_SERVER, devServerArgument],
      cwd,
      env,
      ipc: false,
    },
    devServerPort: port,
    startupTimeoutMs: 3000,
    stopTimeoutMs: 600,
    termGraceMs: 200,
    killReapMs: 200,
    probeIntervalMs: 15,
    ...config.bounds,
  });
  const lane: Lane = { supervisor, markerDir, workerControlDir, astroControlDir, scratch };
  lanes.push(lane);
  return lane;
}

async function markerStamps(markerDir: string, name: string): Promise<bigint[]> {
  try {
    const contents = await readFile(join(markerDir, `${name}.marker`), 'utf8');
    return contents
      .trim()
      .split('\n')
      .map((line) => BigInt(line.split(' ')[1] ?? '0'));
  } catch {
    return [];
  }
}

function crash(controlDir: string): Promise<void> {
  return writeFile(join(controlDir, 'crash'), '', { mode: 0o600 });
}

function rejectedReady(
  supervisor: ProjectPlaneSupervisor,
): Promise<{ code: string; message: string }> {
  return supervisor.ready.then(
    () => {
      throw new Error('ready resolved unexpectedly');
    },
    (error: { code?: string; message?: string }) => ({
      code: error.code ?? 'none',
      message: error.message ?? '',
    }),
  );
}

describe('graceful stop — the ordered close over exact children', () => {
  it('stops ready children in order: worker internals close, then sockets, then both children terminate and reap', async () => {
    const lane = await startLane();
    await lane.supervisor.ready;
    expect(lane.supervisor.state).toBe('running');
    expect(lane.supervisor.admission).toBe('admitted');

    const report = await lane.supervisor.stop();
    expect(report).toMatchObject({
      reason: 'stopped',
      outcome: 'complete',
      failures: [],
    });
    expect(report.accounting).toMatchObject({
      workerReportReceived: true,
      workerCleanupComplete: true,
      workerReaped: true,
      managedAstroReaped: true,
      probesSettled: true,
      killEscalations: [],
    });
    expect(JSON.stringify(report)).not.toContain('pid');

    // The worker's internals closed (its stop + report + exit), and the
    // dev server received its TERM only after that — the AC's close order,
    // proven on monotonic cross-process stamps.
    const workerStop = await markerStamps(lane.markerDir, 'worker-stop-received');
    const workerExit = await markerStamps(lane.markerDir, 'worker-exit');
    const astroTerm = await markerStamps(lane.markerDir, 'astro-term-received');
    const astroExit = await markerStamps(lane.markerDir, 'astro-exit');
    expect(workerStop.length).toBe(1);
    expect(workerExit.length).toBe(1);
    expect(astroTerm.length).toBe(1);
    expect(astroExit.length).toBe(1);
    const first = (stamps: bigint[]): bigint => stamps[0] ?? BigInt(Number.MAX_SAFE_INTEGER);
    expect(first(workerStop)).toBeLessThan(first(astroTerm));
    expect(first(workerExit)).toBeLessThan(first(astroTerm));

    expect(lane.supervisor.state).toBe('closed');
    expect(lane.supervisor.admission).toBe('revoked');
    // Idempotent by contract: a second stop settles the SAME report.
    expect(await lane.supervisor.stop()).toBe(report);
    expect(await lane.supervisor.closed).toBe(report);
  }, 15_000);

  it("the worker's own incomplete cleanup makes the plane's report incomplete", async () => {
    const lane = await startLane({ workerBehaviors: { incompleteReport: true } });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();
    expect(report.reason).toBe('stopped');
    expect(report.outcome).toBe('incomplete');
    expect(report.failures).toEqual(['worker-cleanup-incomplete']);
    expect(report.accounting.workerReportReceived).toBe(true);
    expect(report.accounting.workerCleanupComplete).toBe(false);
  }, 15_000);
});

describe('crash is terminal — the sibling is cleaned, never restarted', () => {
  it('a worker crash terminates the run, revokes admission, and cleans the managed-Astro sibling', async () => {
    const lane = await startLane();
    await lane.supervisor.ready;
    await crash(lane.workerControlDir);

    const report = await lane.supervisor.closed;
    expect(report).toMatchObject({
      reason: 'worker-crash',
      outcome: 'complete',
      failures: [],
    });
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(lane.supervisor.admission).toBe('revoked');
    expect(lane.supervisor.state).toBe('closed');

    // The sibling really closed: its TERM handler ran and it exited.
    expect(await markerStamps(lane.markerDir, 'astro-term-received')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(1);

    // No auto-restart: exactly one boot per child, ever.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await markerStamps(lane.markerDir, 'worker-boot')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-boot')).toHaveLength(1);
  }, 15_000);

  it('a managed-Astro crash stops the worker gracefully and reports it complete', async () => {
    const lane = await startLane();
    await lane.supervisor.ready;
    await crash(lane.astroControlDir);

    const report = await lane.supervisor.closed;
    expect(report).toMatchObject({
      reason: 'managed-astro-crash',
      outcome: 'complete',
      failures: [],
    });
    expect(report.accounting.workerReportReceived).toBe(true);
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(await markerStamps(lane.markerDir, 'worker-stop-received')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await markerStamps(lane.markerDir, 'worker-boot')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-boot')).toHaveLength(1);
  }, 15_000);

  it('a worker boot failure is terminal: ready rejects, the sibling is cleaned, no serving ever happened', async () => {
    const lane = await startLane({ workerBehaviors: { bootFail: true } });
    const rejection = await rejectedReady(lane.supervisor);
    expect(rejection.code).toBe('worker-crash');
    expect(rejection.message).toBe(
      'the project-runtime worker child terminated before the run completed',
    );

    const report = await lane.supervisor.closed;
    expect(report.reason).toBe('worker-crash');
    expect(report.outcome).toBe('complete');
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(existsSync(join(lane.markerDir, 'worker-boot.marker'))).toBe(false);
  }, 15_000);

  it('a dev server that cannot even spawn fails closed with a sanitized startup rejection', async () => {
    const broken = await makeScratch('astroix-sup-');
    const markerDir = join(broken, 'markers');
    await mkdir(markerDir);
    const port = await freePort();
    const supervisor = createProjectPlaneSupervisor({
      worker: {
        executable: process.execPath,
        argv: [STAND_IN_WORKER, JSON.stringify({ markerDir })],
        cwd: broken,
        env: minimalChildEnv(process.env),
        ipc: true,
        execArgv: [],
      },
      managedAstro: {
        executable: join(broken, 'no-such-node-executable'),
        argv: ['dev'],
        cwd: broken,
        env: minimalChildEnv(process.env),
        ipc: false,
      },
      devServerPort: port,
      startupTimeoutMs: 3000,
      stopTimeoutMs: 600,
      termGraceMs: 200,
      killReapMs: 200,
      probeIntervalMs: 15,
    });
    const lane: Lane = {
      supervisor,
      markerDir,
      workerControlDir: broken,
      astroControlDir: broken,
      scratch: broken,
    };
    lanes.push(lane);

    const rejection = await rejectedReady(supervisor);
    expect(rejection.code).toBe('managed-astro-crash');
    expect(rejection.message).toBe(
      'the managed Astro dev server terminated before the run completed',
    );
    expect(rejection.message).not.toContain(broken);
    const report = await supervisor.closed;
    expect(report.reason).toBe('managed-astro-crash');
    expect(report.outcome).toBe('complete');
    expect(report.accounting.workerReportReceived).toBe(true);
  }, 15_000);
});

describe('startup cancellation and the startup deadline', () => {
  it('a stop during startup cancels: both children terminated, probes aborted, complete report', async () => {
    const lane = await startLane({ devServer: { mode: 'hang' } });
    const rejection = rejectedReady(lane.supervisor);
    const report = await lane.supervisor.stop();
    expect(report).toMatchObject({ reason: 'cancelled', outcome: 'complete', failures: [] });
    expect(report.accounting.probesSettled).toBe(true);
    // Both exact children terminated and reaped — a child cancelled
    // mid-boot may die by default SIGTERM before it ever registers an
    // exit handler, so reaping is asserted from the report, not markers.
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect((await rejection).code).toBe('cancelled');
    expect(await markerStamps(lane.markerDir, 'worker-exit')).toHaveLength(1);
  }, 15_000);

  it('a never-ready dev server hits the startup deadline: terminal close, children terminated', async () => {
    const lane = await startLane({
      devServer: { mode: 'hang' },
      bounds: { startupTimeoutMs: 350 },
    });
    const rejection = await rejectedReady(lane.supervisor);
    expect(rejection.code).toBe('startup-timeout');
    expect(rejection.message).toBe(
      'the project plane did not become ready within the startup deadline',
    );

    const report = await lane.supervisor.closed;
    expect(report.reason).toBe('startup-timeout');
    expect(report.outcome).toBe('complete');
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(1);
  }, 15_000);

  it('a worker whose project inspection FAILS is never admitted — the startup deadline terminates the plane', async () => {
    const lane = await startLane({
      workerBehaviors: { probeFail: true },
      bounds: { startupTimeoutMs: 350 },
    });
    const rejection = await rejectedReady(lane.supervisor);
    expect(rejection.code).toBe('startup-timeout');

    const report = await lane.supervisor.closed;
    expect(report.reason).toBe('startup-timeout');
    expect(report.outcome).toBe('complete');
    // Not admitted — and never was: the failed probe answer is not readiness.
    expect(lane.supervisor.admission).toBe('revoked');
    expect(lane.supervisor.state).toBe('closed');
    // The worker stayed alive until the terminal stop (it only ever failed
    // the inspection), answered the stop, and was reaped.
    expect(await markerStamps(lane.markerDir, 'worker-boot')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'worker-stop-received')).toHaveLength(1);
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.managedAstroReaped).toBe(true);
  }, 15_000);
});

describe('escalation and the reap bounds', () => {
  it('an ignored SIGTERM escalates to SIGKILL — reaped, escalated, still complete', async () => {
    const lane = await startLane({ devServer: { ignoreTerm: true } });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();

    expect(report.outcome).toBe('complete');
    expect(report.failures).toEqual([]);
    expect(report.accounting.killEscalations).toEqual(['managed-astro']);
    expect(report.accounting.managedAstroReaped).toBe(true);
    // The TERM really was delivered and ignored; only the KILL ended it
    // (a SIGKILLed process runs no exit handler).
    expect(await markerStamps(lane.markerDir, 'astro-term-received')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(0);
  }, 15_000);

  it('a worker that hangs on stop and ignores TERM fails its report category, then dies by KILL', async () => {
    const lane = await startLane({ workerBehaviors: { hangStop: true } });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();

    expect(report.reason).toBe('stopped');
    expect(report.outcome).toBe('incomplete');
    expect(report.failures).toEqual(['worker-close-report']);
    expect(report.accounting.workerReportReceived).toBe(false);
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.killEscalations).toEqual(['worker']);
    // The stop really reached the worker (its marker proves receipt) and
    // the TERM really was ignored — only the KILL ladder ended it.
    expect(await markerStamps(lane.markerDir, 'worker-stop-received')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'worker-term-ignored')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'worker-exit')).toHaveLength(0);
  }, 15_000);

  it('an unobserved exit after SIGKILL reports the honest incomplete reap — no PID, no false complete', async () => {
    const lane = await startLane({
      devServer: { termDelayMs: 5000 },
      bounds: { killReapMs: 0 },
    });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();

    expect(report.outcome).toBe('incomplete');
    expect(report.failures).toContain('managed-astro-reap');
    expect(report.accounting.managedAstroReaped).toBe(false);
    expect(report.accounting.workerReaped).toBe(true);
    expect(JSON.stringify(report)).not.toContain('pid');
  }, 15_000);
});

describe('the exact-child spawn discipline over real children', () => {
  it('spawns exact executables with explicit argv into a metacharacter canonical cwd under a poisoned environment', async () => {
    const scratch = await makeScratch('astroix-sup-');
    const hostileBin = join(scratch, 'hostile-bin');
    await mkdir(hostileBin);
    const hostile = (): string =>
      `#!/bin/sh\necho pwned > ${JSON.stringify(join(scratch, 'hostile-ran.marker'))}\nexit 66\n`;
    await writeFile(join(hostileBin, 'node'), hostile(), { mode: 0o755 });
    await writeFile(join(hostileBin, 'astro'), hostile(), { mode: 0o755 });

    const poisoned: Record<string, string | undefined> = {
      PATH: `${hostileBin}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      NODE_OPTIONS: '--require /nonexistent/pwned.cjs',
      ASTROIX_SECRET: 'sekrit-value',
      GITHUB_TOKEN: 'ghp-hostile',
    };
    // A shell would eat this root alive: metacharacters, spaces, the works.
    const metacharRoot = join(scratch, 'prj-;touch pwned $(pwned) `id`');
    await mkdir(metacharRoot);

    const env = minimalChildEnv(poisoned);
    const workerSnapshot = join(scratch, 'worker-snapshot.json');
    const astroSnapshot = join(scratch, 'astro-snapshot.json');
    const lane = await startLane({
      env,
      cwd: metacharRoot,
      workerSnapshotPath: workerSnapshot,
      astroSnapshotPath: astroSnapshot,
      bounds: { startupTimeoutMs: 8000 },
    });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();
    expect(report.outcome).toBe('complete');

    const canonical = await realpath(metacharRoot);
    const worker = JSON.parse(await readFile(workerSnapshot, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };
    const astro = JSON.parse(await readFile(astroSnapshot, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };

    // Canonical cwd, exact executable, argv passed as single tokens.
    // (macOS injects __CF_USER_TEXT_ENCODING into every spawned child's
    // environment at the syscall boundary — the one platform addition,
    // never ours; everything else must be the whitelist exactly.)
    const platformInjected = new Set(['__CF_USER_TEXT_ENCODING']);
    const childEnvKeys = (child: { env: Record<string, string> }): string[] =>
      Object.keys(child.env)
        .filter((key) => !platformInjected.has(key))
        .sort();
    for (const child of [worker, astro]) {
      expect(child.cwd).toBe(canonical);
      expect(child.argv[0]).toBe(process.execPath);
      expect(childEnvKeys(child)).toEqual(Object.keys(env).sort());
      for (const [key, value] of Object.entries(env)) {
        expect(child.env[key]).toBe(value);
      }
      expect(Object.hasOwn(child.env, 'NODE_OPTIONS')).toBe(false);
    }
    expect(worker.argv[1]).toBe(STAND_IN_WORKER);
    expect(astro.argv[1]).toBe(STAND_IN_DEV_SERVER);
    const astroArgument = JSON.parse(astro.argv[2] ?? '{}') as { port?: number };
    expect(typeof astroArgument.port).toBe('number');

    // Secret-free: the serialized child environments carry none of the poisons.
    for (const serialized of [JSON.stringify(worker.env), JSON.stringify(astro.env)]) {
      expect(serialized).not.toContain('sekrit');
      expect(serialized).not.toContain('ghp-');
    }

    // No shell ever parsed anything: the metacharacter root produced no
    // side-effect files, and the PATH-hostile executables never ran.
    expect(existsSync(join(scratch, 'hostile-ran.marker'))).toBe(false);
    expect(existsSync(join(scratch, 'pwned'))).toBe(false);
    expect(existsSync(join(metacharRoot, 'pwned'))).toBe(false);
    expect(existsSync(join(canonical, 'pwned'))).toBe(false);
  }, 20_000);
});

describe('the production worker spawn plan', () => {
  it("forks E6's worker-child out of the canonical root, with the bundled-Node override mirroring the dev-server plan", async () => {
    const scratch = await makeScratch('astroix-sup-');
    const canonical = await realpath(scratch);

    const plan = await workerSpawnPlan({ projectRoot: scratch });
    expect(plan.executable).toBe(process.execPath);
    expect(plan.ipc).toBe(true);
    expect(plan.cwd).toBe(canonical);
    expect(plan.argv[0]).toMatch(/worker-child\.ts$/); // the dev-checkout spelling; the packaged runtime rebases (ADR-0008)
    expect(JSON.parse(plan.argv[1] ?? '{}')).toEqual({ projectRoot: canonical });
    expect(plan.env.ASTRO_TELEMETRY_DISABLED).toBe('1');
    expect(Object.hasOwn(plan.env, 'NODE_OPTIONS')).toBe(false);

    // The sibling symmetry the reviewer pinned: one executable override
    // shape for both children — the packaged runtime's bundled stock Node.
    const overridden = await workerSpawnPlan({
      projectRoot: scratch,
      nodeExecutable: '/opt/astroix-node/bin/node',
    });
    expect(overridden.executable).toBe('/opt/astroix-node/bin/node');
    expect(overridden.cwd).toBe(canonical);
  });
});
