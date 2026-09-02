import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BootCapability } from '../../private-boot/control-plane-boot.ts';

// @vitest-environment node — forks real children from real file paths; no DOM.
/**
 * The private-boot process lane (#222 focused tests): the exact
 * control-plane child boots over its real private IPC channel with a
 * real one-use capability and the real `process.exit` — second
 * control-plane exclusion before listener bind, the replacement-main
 * exclusion until the old child's exit releases the lease, the
 * disconnect fence order, and the abrupt-main-death path. The test
 * process plays Electron main: it spawns the child, mints the
 * capability, and confers it over the channel.
 */

const CHILD = fileURLToPath(new URL('./control-plane-child-runner.ts', import.meta.url));
const MAIN_MIDDLE = fileURLToPath(new URL('./main-middle-runner.ts', import.meta.url));

const scratchDirs: string[] = [];
const children: ChildProcess[] = [];

interface ChildRun {
  child: ChildProcess;
  held: Promise<void>;
  heldMarkerPath: string;
  releaseMarkerPath: string;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.connected) child.disconnect();
    child.kill('SIGKILL');
  }
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astroix-cp-'));
  scratchDirs.push(dir);
  return dir;
}

function spawnControlPlaneChild(
  privateStateDirectory: string,
  qualifiedRuntime: 'current' | 'wrong-node' = 'current',
): ChildRun {
  const heldMarkerPath = join(privateStateDirectory, `held-${children.length}.marker`);
  const releaseMarkerPath = join(privateStateDirectory, `release-${children.length}.marker`);
  const child = fork(CHILD, [
    JSON.stringify({ privateStateDirectory, qualifiedRuntime, heldMarkerPath, releaseMarkerPath }),
  ]);
  children.push(child);
  const held = new Promise<void>((resolve) => {
    child.on('message', (message: unknown) => {
      if ((message as { type?: string } | null)?.type === 'held') resolve();
    });
  });
  return { child, held, heldMarkerPath, releaseMarkerPath };
}

function conferCapability(child: ChildProcess): void {
  child.send(BootCapability.mint().toWireMessage());
}

function exitOf(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function readMarker(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).trim();
}

/** Waits for a deterministic condition with a deadline — observation polling, never a timing assertion. */
async function waitFor(
  description: string,
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function pidIsGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe('the exact control-plane child', () => {
  it('boots: capability conferred, lease held, then listener bind and held report', async () => {
    const dir = await makeStateDir();
    const run = spawnControlPlaneChild(dir);
    conferCapability(run.child);
    await run.held;
    expect(await readMarker(run.heldMarkerPath)).toBe('listeners-bound');
    expect(existsSync(run.releaseMarkerPath)).toBe(false);
    run.child.disconnect();
    expect(await exitOf(run.child)).toEqual({ code: 0, signal: null });
  });

  it('never boots without a conferred capability — no lease, no listener bind', async () => {
    const dir = await makeStateDir();
    const run = spawnControlPlaneChild(dir);
    run.child.disconnect();
    expect(await exitOf(run.child)).toEqual({ code: 76, signal: null });
    expect(existsSync(run.heldMarkerPath)).toBe(false);
    expect(existsSync(join(dir, 'registry-writer.sqlite'))).toBe(false);
  });
});

describe('second control-plane exclusion', () => {
  it('exits with contention before listener bind or project spawn', async () => {
    const dir = await makeStateDir();
    const first = spawnControlPlaneChild(dir);
    conferCapability(first.child);
    await first.held;

    const second = spawnControlPlaneChild(dir);
    conferCapability(second.child);
    expect(await exitOf(second.child)).toEqual({ code: 73, signal: null });
    // Listener bind and project spawn never ran: no held report, no markers, no release.
    expect(existsSync(second.heldMarkerPath)).toBe(false);
    expect(existsSync(second.releaseMarkerPath)).toBe(false);

    first.child.disconnect();
    expect(await exitOf(first.child)).toEqual({ code: 0, signal: null });
  });
});

describe('replacement main', () => {
  it('is excluded until the old child actually releases — then a fresh child acquires', async () => {
    const dir = await makeStateDir();
    const old = spawnControlPlaneChild(dir);
    conferCapability(old.child);
    await old.held;

    // A replacement main's child fails closed while the old child still holds the lease.
    const replacement = spawnControlPlaneChild(dir);
    conferCapability(replacement.child);
    expect(await exitOf(replacement.child)).toEqual({ code: 73, signal: null });

    // The old child's channel closes: fence → listener release → exit (the exit is the lease release).
    old.child.disconnect();
    expect(await exitOf(old.child)).toEqual({ code: 0, signal: null });
    expect(await readMarker(old.releaseMarkerPath)).toBe('released-after-fence');

    // Only now may the replacement's next child acquire.
    const successor = spawnControlPlaneChild(dir);
    conferCapability(successor.child);
    await successor.held;
    successor.child.disconnect();
    expect(await exitOf(successor.child)).toEqual({ code: 0, signal: null });
  });
});

describe('abrupt main death', () => {
  it('a SIGKILLED main fences and exits its child — the successor acquires after that exit', async () => {
    const dir = await makeStateDir();
    // The middle process stands in for Electron main: it owns the child's private channel.
    const middle = fork(MAIN_MIDDLE, [JSON.stringify({ privateStateDirectory: dir })], {
      stdio: 'ignore',
    });
    children.push(middle);
    let grandchildPid: number | undefined;
    let held = false;
    middle.on('message', (message: unknown) => {
      const record = message as { type?: string; pid?: number } | null;
      if (record?.type === 'pid') grandchildPid = record.pid;
      if (record?.type === 'held') held = true;
    });
    const middleExit = exitOf(middle);
    await waitFor('grandchild held', () => held && grandchildPid !== undefined);

    middle.kill('SIGKILL');
    expect((await middleExit).signal).toBe('SIGKILL');
    // The orphaned control-plane child saw its private channel close: it fenced, released, and exited.
    await waitFor('control-plane child exit', () => pidIsGone(grandchildPid));
    expect(await readFile(join(dir, 'middle-release.marker'), 'utf8')).toBe(
      'released-after-fence\n',
    );

    const successor = spawnControlPlaneChild(dir);
    conferCapability(successor.child);
    await successor.held;
    successor.child.disconnect();
    expect(await exitOf(successor.child)).toEqual({ code: 0, signal: null });
  }, 20_000);
});

describe('runtime gates at boot', () => {
  it('a wrong Node pin child fails closed: no authority, no lease file, failure exit', async () => {
    const dir = await makeStateDir();
    const run = spawnControlPlaneChild(dir, 'wrong-node');
    conferCapability(run.child);
    expect(await exitOf(run.child)).toEqual({ code: 74, signal: null });
    expect(existsSync(run.heldMarkerPath)).toBe(false);
    expect(existsSync(join(dir, 'registry-writer.sqlite'))).toBe(false);
  });
});
