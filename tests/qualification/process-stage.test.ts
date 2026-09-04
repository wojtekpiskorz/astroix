import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  launchTerminateAndAudit,
  type ProcessStageInput,
  processesReferencing,
} from '../../scripts/qualification/process-stage.ts';

/**
 * The process stage of the qualification harness (#258, L1 focused
 * tests — the process legs): launch failure, timeout, and incomplete
 * cleanup, over real stub executables in real isolation roots. These
 * run everywhere the harness's tests do (signal-only quit mode — no
 * macOS surface is needed), and every bound is tight so the negative
 * legs stay fast: a hostile or broken artifact can never hang the
 * harness.
 */

let staging: string;

beforeEach(async () => {
  staging = await mkdtemp(join(tmpdir(), 'astroix-qualification-process-'));
});

afterEach(async () => {
  // belt: the harness should have reaped everything, but a test bug
  // must never leak processes into the suite
  for (const row of await processesReferencing(staging)) {
    try {
      process.kill(Number(row.pid), 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await rm(staging, { recursive: true, force: true });
});

interface StubApp {
  readonly appPath: string;
  readonly stagingRoot: string;
}

/** One stub "app": a shell script at the packaged executable position, inside a fresh staging root. */
async function stubApp(name: string, script: string): Promise<StubApp> {
  const root = join(staging, name);
  const appPath = join(root, 'Astroix.app');
  await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, 'user-data'), { recursive: true });
  const executable = join(appPath, 'Contents', 'MacOS', 'Astroix');
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  return { appPath, stagingRoot: root };
}

function input(stub: StubApp, overrides: Partial<ProcessStageInput> = {}): ProcessStageInput {
  return {
    appPath: stub.appPath,
    executableName: 'Astroix',
    bundleId: 'dev.astroix.app',
    stagingRoot: stub.stagingRoot,
    settleMs: 1500,
    quitTimeoutMs: 2000,
    quitMode: 'signal-only',
    termBoundMs: 2000,
    killBoundMs: 2000,
    residualPollMs: 8000,
    ...overrides,
  };
}

/** The well-behaved stub: stays up, exits 0 on SIGTERM. */
const GOOD_STUB = '#!/bin/sh\ntrap "exit 0" TERM\nwhile :; do sleep 0.2; done\n';

describe('the qualification process stage over stub executables (#258)', () => {
  it('a well-behaved app passes: alive through settle, exits on SIGTERM, zero residuals', async () => {
    const stub = await stubApp('good', GOOD_STUB);
    const verdicts = await launchTerminateAndAudit(input(stub));
    expect(verdicts.launchOk).toBe(true);
    expect(verdicts.terminationOk).toBe(true);
    expect(verdicts.residualOk).toBe(true);
    expect(verdicts.record.settle.aliveAtSettle).toBe(true);
    expect(verdicts.record.termination.outcome).toBe('exited-after-signal');
    expect(verdicts.record.termination.exitCode).toBe(0);
    expect(verdicts.record.residualAudit.residuals).toEqual([]);
    // the isolation law's env composition is recorded, not just applied
    expect(verdicts.record.env.home).toBe(join(stub.stagingRoot, 'home'));
    expect(verdicts.record.env.userData).toBe(join(stub.stagingRoot, 'user-data'));
    expect(verdicts.record.argv).toContain(
      `--user-data-dir=${join(stub.stagingRoot, 'user-data')}`,
    );
  }, 30_000);

  it('launches under a minimal allowlisted env — the harness environment never reaches the app', async () => {
    // the stub dumps its own environment to a file; the harness host
    // carries hostile ambient vars during the launch — none of them may
    // appear in the app's environment (the #231 whitelisted-env law;
    // review round 1 on #373)
    const dump = join(staging, 'launched-env.txt');
    const stub = await stubApp(
      'env-probe',
      `#!/bin/sh\nenv > "${dump}"\ntrap "exit 0" TERM\nwhile :; do sleep 0.2; done\n`,
    );
    const previous = {
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      ASTROIX_QUALIFICATION_ARTIFACT: process.env.ASTROIX_QUALIFICATION_ARTIFACT,
    };
    process.env.NODE_OPTIONS = '--max-old-space-size=2048';
    process.env.ASTROIX_QUALIFICATION_ARTIFACT = '/tmp/decoy.zip';
    try {
      const verdicts = await launchTerminateAndAudit(input(stub));
      expect(verdicts.launchOk).toBe(true);
      const launched = await readFile(dump, 'utf8');
      const launchedEnv = new Map(
        launched
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1)] as const;
          }),
      );
      // the isolation law's own vars are present…
      expect(launchedEnv.get('HOME')).toBe(join(stub.stagingRoot, 'home'));
      expect(launchedEnv.get('ASTROIX_DESKTOP_USER_DATA')).toBe(
        join(stub.stagingRoot, 'user-data'),
      );
      // …and NOTHING of the harness host's environment rides along
      expect(launchedEnv.has('NODE_OPTIONS')).toBe(false);
      expect(launchedEnv.has('ASTROIX_QUALIFICATION_ARTIFACT')).toBe(false);
      expect(launchedEnv.has('ELECTRON_ENABLE_LOGGING')).toBe(true); // the one fixed var
      const inherited = verdicts.record.env.inheritedKeys;
      for (const key of launchedEnv.keys()) {
        const known =
          key === 'HOME' ||
          key === 'ASTROIX_DESKTOP_USER_DATA' ||
          key === 'ELECTRON_ENABLE_LOGGING' ||
          // the stub's own shell sets these as it starts — shell state,
          // never harness inheritance
          key === 'PWD' ||
          key === 'SHLVL' ||
          key === '_' ||
          inherited.includes(key);
        expect(known, `unexpected env key in the launched app: ${key}`).toBe(true);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30_000);

  it('a launch failure fails closed: an app that exits during settle never reaches termination', async () => {
    const stub = await stubApp('exits', '#!/bin/sh\necho starting\nexit 3\n');
    const verdicts = await launchTerminateAndAudit(input(stub));
    expect(verdicts.launchOk).toBe(false);
    expect(verdicts.terminationOk).toBe(false);
    expect(verdicts.record.settle.earlyExit).toEqual({ code: 3, signal: null });
    expect(verdicts.record.termination.outcome).toBe('launch-failed');
    expect(verdicts.record.stdoutTail).toContain('starting');
  }, 30_000);

  it('a missing executable is a spawn error, recorded — never an unhandled crash', async () => {
    const stub = await stubApp('absent', GOOD_STUB);
    await rm(join(stub.appPath, 'Contents', 'MacOS', 'Astroix'));
    const verdicts = await launchTerminateAndAudit(input(stub));
    expect(verdicts.launchOk).toBe(false);
    expect(verdicts.record.termination.outcome).toBe('spawn-error');
    expect(verdicts.record.spawnError).not.toBeNull();
  }, 30_000);

  it('a non-executable binary is a spawn error', async () => {
    const stub = await stubApp('noexec', GOOD_STUB);
    await chmod(join(stub.appPath, 'Contents', 'MacOS', 'Astroix'), 0o644);
    const verdicts = await launchTerminateAndAudit(input(stub));
    expect(verdicts.launchOk).toBe(false);
    expect(verdicts.record.termination.outcome).toBe('spawn-error');
  }, 30_000);

  it('a timeout fails closed and bounded: an app ignoring SIGTERM is SIGKILLed, never waited on forever', async () => {
    const stub = await stubApp(
      'ignores-term',
      '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 0.2; done\n',
    );
    const startedAt = Date.now();
    const verdicts = await launchTerminateAndAudit(input(stub));
    const elapsed = Date.now() - startedAt;
    expect(verdicts.launchOk).toBe(true);
    expect(verdicts.terminationOk).toBe(false);
    expect(verdicts.record.termination.outcome).toBe('termination-forced');
    // bounded: settle + TERM bound + KILL bound + residual polls, with margin
    expect(elapsed).toBeLessThan(30_000);
    expect(verdicts.residualOk).toBe(true); // the SIGKILL tree reaped it
  }, 60_000);

  it('incomplete cleanup fails closed: an owned child that survives the app is named and killed', async () => {
    // the lingering child is planted by the test, inside the staging
    // root — its argv references the root, the owned-process audit's
    // shape; the stub app spawns it and then behaves perfectly itself
    const stub = await stubApp('lingers', GOOD_STUB);
    const stagingRoot = stub.stagingRoot;
    const lingerChild = join(stagingRoot, 'linger-child.sh');
    const ready = join(stagingRoot, 'child-ready');
    // a readiness handshake makes the child's existence PROVABLE before
    // termination starts — no spawn race under load
    await writeFile(
      lingerChild,
      `#!/bin/sh\ntrap "" TERM\ntouch "${ready}"\nwhile :; do sleep 0.2; done\n`,
    );
    await chmod(lingerChild, 0o755);
    const spawner = join(stagingRoot, 'spawn-child.sh');
    await writeFile(
      spawner,
      `#!/bin/sh\n"${lingerChild}" &\nwhile [ ! -f "${ready}" ]; do sleep 0.05; done\ntrap "exit 0" TERM\nwhile :; do sleep 0.2; done\n`,
    );
    await chmod(spawner, 0o755);
    await writeFile(
      join(stub.appPath, 'Contents', 'MacOS', 'Astroix'),
      `#!/bin/sh\nexec "${spawner}"\n`,
    );
    await chmod(join(stub.appPath, 'Contents', 'MacOS', 'Astroix'), 0o755);
    const verdicts = await launchTerminateAndAudit(input(stub));
    expect(verdicts.launchOk).toBe(true);
    expect(verdicts.terminationOk).toBe(true); // the app itself quit on SIGTERM
    expect(verdicts.residualOk).toBe(false); // but its child survived
    expect(verdicts.record.residualAudit.residuals.length).toBeGreaterThanOrEqual(1);
    expect(
      verdicts.record.residualAudit.residuals.some((row) =>
        row.command.includes('linger-child.sh'),
      ),
    ).toBe(true);
    // the harness cleaned the machine even while failing the run
    expect(verdicts.record.residualAudit.harnessKilled.length).toBeGreaterThanOrEqual(1);
    expect(verdicts.record.residualAudit.postKillResiduals).toEqual([]);
    expect(await processesReferencing(stagingRoot)).toEqual([]);
  }, 60_000);
});
