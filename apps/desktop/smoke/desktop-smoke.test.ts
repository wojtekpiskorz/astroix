import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The Electron smoke lane (#243 focused tests): launches the REAL
 * Electron 44.1.0 binary running the REAL main wiring over a REAL
 * control-plane child (private boot, kernel lease, production registry in
 * an isolated user-data root) — and asserts the security posture
 * end-to-end: the window preferences, every denial (permissions, popups,
 * downloads, webviews, unapproved top-level navigation), the no-bridge
 * law, and the singleton behavior (a second command-line launch leaves
 * the existing instance authoritative).
 *
 * Lane gate, never release evidence (ADR-0008): an instrumented Electron
 * build may test wiring but is never release evidence — the packaged
 * qualification is H6's.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const REPO = join(DESKTOP, '..', '..');
const MAIN_BUNDLE = join(DESKTOP, 'dist-main', 'main.js');
const ELECTRON = join(REPO, 'node_modules', '.bin', 'electron');

interface SmokeLine {
  readonly kind: string;
  readonly probe?: string;
  readonly denied?: boolean;
  readonly detail?: Record<string, unknown>;
  [field: string]: unknown;
}

interface ElectronRun {
  readonly child: ChildProcess;
  readonly lines: string[];
  readonly events: SmokeLine[];
  readonly findings: SmokeLine[];
  exit: Promise<{ code: number | null; signal: string | null }>;
  /** Resolves as soon as one matching line lands. */
  waitForLine(match: (line: string) => boolean, what: string): Promise<string>;
}

const runs: ElectronRun[] = [];

function launchElectron(userData: string, smoke: boolean): ElectronRun {
  const child = spawn(ELECTRON, [MAIN_BUNDLE], {
    cwd: REPO,
    env: {
      ...process.env,
      ASTROIX_DESKTOP_NODE: process.execPath,
      ASTROIX_DESKTOP_USER_DATA: userData,
      ASTROIX_DESKTOP_DEV_CURRENT_PIN: '1',
      ...(smoke ? { ASTROIX_DESKTOP_SMOKE: 'security' } : {}),
      ELECTRON_ENABLE_LOGGING: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const waiters: Array<{
    match: (line: string) => boolean;
    resolve: (line: string) => void;
    what: string;
  }> = [];
  const pump = (chunk: Buffer): void => {
    for (const raw of chunk.toString('utf8').split('\n')) {
      const line = raw.trim();
      if (line.length === 0) continue;
      lines.push(line);
      for (let index = 0; index < waiters.length; index += 1) {
        if (waiters[index]?.match(line)) {
          const waiter = waiters.splice(index, 1)[0];
          waiter?.resolve(line);
          index -= 1;
        }
      }
    }
  };
  child.stdout?.on('data', pump);
  child.stderr?.on('data', (chunk: Buffer) => {
    lines.push(`stderr: ${chunk.toString('utf8').trim()}`);
  });
  const run: ElectronRun = {
    child,
    lines,
    exit: new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    }),
    get events(): SmokeLine[] {
      return lines
        .filter((line) => line.startsWith('astroix-desktop: '))
        .map((line) => JSON.parse(line.slice('astroix-desktop: '.length)) as SmokeLine);
    },
    get findings(): SmokeLine[] {
      return lines
        .filter((line) => line.startsWith('astroix-desktop-smoke: {'))
        .map((line) => JSON.parse(line.slice('astroix-desktop-smoke: '.length)) as SmokeLine);
    },
    waitForLine: (match, what) =>
      new Promise<string>((resolve, reject) => {
        const already = lines.find(match);
        if (already !== undefined) {
          resolve(already);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${what}; lines so far:\n${lines.join('\n')}`));
        }, 60_000);
        waiters.push({
          match: (line) => {
            if (match(line)) {
              clearTimeout(timer);
              resolve(line);
              return true;
            }
            return false;
          },
          resolve,
          what,
        });
      }),
  };
  runs.push(run);
  return run;
}

let userData: string;
const scratchDirs: string[] = [];

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'astroix-desktop-smoke-'));
  scratchDirs.push(userData);
});

afterEach(async () => {
  for (const run of runs.splice(0)) {
    if (run.child.exitCode === null && !run.child.killed) {
      run.child.kill('SIGTERM');
      const settled = await Promise.race([
        run.exit,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      if ((settled as { code: number | null } | null)?.code === null) {
        run.child.kill('SIGKILL');
        await run.exit.catch(() => {});
      }
    }
  }
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('the thin Electron host — security smoke (real Electron, real child)', () => {
  it('boots the control-plane child through the private boot and holds every denial', async () => {
    const run = launchElectron(userData, true);
    const booted = await run.waitForLine(
      (line) => line.startsWith('astroix-desktop: ') && line.includes('control-plane-booted'),
      'the control-plane child boot',
    );
    expect(booted).toBeTruthy();
    await run.waitForLine((line) => line === 'astroix-desktop-smoke: done', 'the probe sequence');

    const findings = run.findings;
    const probes = new Map(findings.map((finding) => [finding.probe, finding]));
    expect(findings.map((finding) => finding.probe)).toEqual([
      'preferences',
      'popup',
      'permissions',
      'download',
      'webview',
      'navigation',
      'bridge',
    ]);

    const preferences = probes.get('preferences');
    if (preferences?.denied !== true) {
      throw new Error(`preferences probe not secure: ${JSON.stringify(preferences)}`);
    }
    expect(preferences?.denied).toBe(true);
    expect(preferences?.detail).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      preload: null,
    });

    for (const probe of ['popup', 'permissions', 'download', 'webview', 'navigation', 'bridge']) {
      expect(probes.get(probe)?.denied, `probe ${probe} must be denied`).toBe(true);
    }
  }, 180_000);

  it('keeps the existing instance authoritative across a second command-line launch', async () => {
    const first = launchElectron(userData, true);
    await first.waitForLine(
      (line) => line.startsWith('astroix-desktop: ') && line.includes('control-plane-booted'),
      'the first instance boot',
    );
    const second = launchElectron(userData, false);
    const refused = await second.waitForLine(
      (line) => line.startsWith('astroix-desktop: ') && line.includes('singleton-refused'),
      'the second instance refusal',
    );
    expect(refused).toBeTruthy();
    await second.exit; // the junior instance quits on its own
    await first.waitForLine(
      (line) => line.startsWith('astroix-desktop: ') && line.includes('second-instance'),
      'the existing instance receiving the second launch',
    );
    // the existing instance stays authoritative: it never quit and never lost its child
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(first.child.exitCode).toBeNull();
    const lostEvents = first.events.filter((event) => event.kind === 'control-plane-lost');
    expect(lostEvents).toEqual([]);
  }, 180_000);
});
