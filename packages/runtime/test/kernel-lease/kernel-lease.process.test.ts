import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// @vitest-environment node — forks real children from real file paths; no DOM.
/**
 * The kernel-lease process lane (#222 focused tests): barrier-started
 * same-name contenders, separate-file concurrency, SIGKILL crash release,
 * the live orphan, the wrong-Node fail-closed gate, and poisoned-PATH
 * independence — every case a real child process over a real private
 * state directory, asserted on IPC messages and exit events, never
 * timing. This is the #209 crash-and-contention matrix at the module
 * seam; the packaged-integrity and two-platform legs belong to the
 * packaging lanes (ADR-0008).
 */

const HOLDER = fileURLToPath(new URL('./lease-holder-runner.ts', import.meta.url));
const ORPHAN_MIDDLE = fileURLToPath(new URL('./orphan-middle-runner.ts', import.meta.url));

const scratchDirs: string[] = [];
const children: ChildProcess[] = [];

interface HolderOutcome {
  child: ChildProcess;
  /** Resolves when the runner has its message listener attached — 'start' can be sent from here on. */
  ready: Promise<void>;
  acquired: Promise<boolean>;
  deniedCode: Promise<string | null>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.connected) child.disconnect();
    child.kill('SIGKILL');
  }
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStateDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `astroix-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

function forkHolder(
  privateStateDirectory: string,
  options: {
    role?: 'registry-writer' | 'edit-writer';
    qualifiedRuntime?: 'current' | 'wrong-node' | 'wrong-sqlite';
    env?: NodeJS.ProcessEnv;
    orphanGoFile?: string;
    exitMarkerPath?: string;
  } = {},
): HolderOutcome {
  const child = fork(
    HOLDER,
    [
      JSON.stringify({
        role: options.role ?? 'registry-writer',
        privateStateDirectory,
        qualifiedRuntime: options.qualifiedRuntime ?? 'current',
        orphanGoFile: options.orphanGoFile,
        exitMarkerPath: options.exitMarkerPath,
      }),
    ],
    { env: options.env },
  );
  children.push(child);
  const ready = new Promise<void>((resolveReady) => {
    child.on('message', (message: unknown) => {
      if ((message as { type?: string } | null)?.type === 'ready') resolveReady();
    });
  });
  let resolveAcquired: ((acquired: boolean) => void) | undefined;
  const acquired = new Promise<boolean>((resolve) => {
    resolveAcquired = resolve;
  });
  let resolveDenied: ((code: string | null) => void) | undefined;
  const deniedCode = new Promise<string | null>((resolve) => {
    resolveDenied = resolve;
  });
  child.on('message', (message: unknown) => {
    const record = message as { type?: string; code?: string } | null;
    if (record?.type === 'acquired') resolveAcquired?.(true);
    if (record?.type === 'denied') {
      resolveDenied?.(record.code ?? null);
      resolveAcquired?.(false);
    }
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, ready, acquired, deniedCode, exit };
}

function start(child: ChildProcess): void {
  child.send({ type: 'start' });
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

describe('barrier-started same-name contenders', () => {
  it('lets exactly one of three processes acquire; the others fail closed with contention exits', async () => {
    const dir = await makeStateDir('barrier');
    const contenders = [forkHolder(dir), forkHolder(dir), forkHolder(dir)];
    // The barrier: nobody starts until every runner has its listener attached.
    await Promise.all(contenders.map((contender) => contender.ready));
    for (const contender of contenders) {
      start(contender.child);
    }
    const outcomes = await Promise.all(contenders.map((contender) => contender.acquired));
    expect(outcomes.filter((acquired) => acquired)).toHaveLength(1);
    // Clean handoff: the one winner exits cleanly by command — its process exit is the lease release.
    const winner = contenders.find((_, index) => outcomes[index] === true);
    if (winner === undefined) throw new Error('no contender acquired the lease');
    winner.child.send({ type: 'shutdown' });
    expect(await winner.exit).toEqual({ code: 0, signal: null });
    const deniedExits = await Promise.all(
      contenders.filter((_, index) => !outcomes[index]).map((contender) => contender.exit),
    );
    expect(deniedExits).toEqual([
      { code: 73, signal: null },
      { code: 73, signal: null },
    ]);
    const deniedCodes = await Promise.all(
      contenders.filter((_, index) => !outcomes[index]).map((contender) => contender.deniedCode),
    );
    expect(deniedCodes).toEqual([
      'ASTROIX_KERNEL_LEASE_UNAVAILABLE',
      'ASTROIX_KERNEL_LEASE_UNAVAILABLE',
    ]);
  }, 20_000);
});

describe('separate fixed files', () => {
  it('holds registry-writer and edit-writer concurrently in two processes', async () => {
    const dir = await makeStateDir('separate');
    const registryHolder = forkHolder(dir, { role: 'registry-writer' });
    const editHolder = forkHolder(dir, { role: 'edit-writer' });
    await Promise.all([registryHolder.ready, editHolder.ready]);
    start(registryHolder.child);
    start(editHolder.child);
    expect(await registryHolder.acquired).toBe(true);
    expect(await editHolder.acquired).toBe(true);
    registryHolder.child.send({ type: 'shutdown' });
    editHolder.child.send({ type: 'shutdown' });
    expect(await registryHolder.exit).toEqual({ code: 0, signal: null });
    expect(await editHolder.exit).toEqual({ code: 0, signal: null });
  });
});

describe('crash release (SIGKILL)', () => {
  it('a successor acquires with no unlink, heartbeat, or stale-owner cleanup — the file remains', async () => {
    const dir = await makeStateDir('sigkill');
    const crashed = forkHolder(dir, { exitMarkerPath: join(dir, 'crashed-exit-marker') });
    await crashed.ready;
    start(crashed.child);
    expect(await crashed.acquired).toBe(true);
    const leaseFile = join(dir, 'registry-writer.sqlite');
    expect(existsSync(leaseFile)).toBe(true);
    crashed.child.kill('SIGKILL');
    expect((await crashed.exit).signal).toBe('SIGKILL');
    // No cleanup ran — no exit marker, and the lease file was never unlinked.
    expect(existsSync(join(dir, 'crashed-exit-marker'))).toBe(false);
    expect(existsSync(leaseFile)).toBe(true);
    const successor = forkHolder(dir);
    await successor.ready;
    start(successor.child);
    expect(await successor.acquired).toBe(true);
    successor.child.send({ type: 'shutdown' });
    expect(await successor.exit).toEqual({ code: 0, signal: null });
  });
});

describe('live orphan', () => {
  it('a parent-killed holder keeps excluding replacements until that exact process exits', async () => {
    const dir = await makeStateDir('orphan');
    const orphanGoFile = join(dir, 'orphan-go');
    const middle = fork(ORPHAN_MIDDLE, [
      JSON.stringify({
        holderArgs: [
          JSON.stringify({ role: 'edit-writer', privateStateDirectory: dir, orphanGoFile }),
        ],
      }),
    ]);
    children.push(middle);
    let holderPid: number | undefined;
    let holderAcquired = false;
    middle.on('message', (message: unknown) => {
      const record = message as { type?: string; pid?: number } | null;
      if (record?.type === 'ready') holderPid = record.pid;
      if (record?.type === 'acquired') holderAcquired = true;
    });
    const middleExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        middle.on('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    await waitFor('holder ready', () => holderPid !== undefined);
    middle.send({ type: 'start' }); // relayed down to the holder — it acquires under its real parent
    await waitFor('holder acquired', () => holderAcquired);
    middle.kill('SIGKILL');
    expect((await middleExit).signal).toBe('SIGKILL');
    await waitFor('orphan alive after reparenting', () => !pidIsGone(holderPid));

    // The orphan still holds the edit-writer lease: a replacement fails closed.
    const replacement = forkHolder(dir, { role: 'edit-writer' });
    await replacement.ready;
    start(replacement.child);
    expect(await replacement.acquired).toBe(false);
    expect(await replacement.deniedCode).toBe('ASTROIX_KERNEL_LEASE_UNAVAILABLE');
    expect(await replacement.exit).toEqual({ code: 73, signal: null });

    // That exact process exiting is the release — the successor then acquires.
    await writeFile(orphanGoFile, 'go\n', { mode: 0o600 });
    await waitFor('orphan exit', () => pidIsGone(holderPid));
    const successor = forkHolder(dir, { role: 'edit-writer' });
    await successor.ready;
    start(successor.child);
    expect(await successor.acquired).toBe(true);
    successor.child.send({ type: 'shutdown' });
    expect(await successor.exit).toEqual({ code: 0, signal: null });
  }, 20_000);
});

describe('fail-closed runtime gates', () => {
  it('wrong Node pin: no acquisition, failure exit, no lease file', async () => {
    const dir = await makeStateDir('wrong-node');
    const holder = forkHolder(dir, { qualifiedRuntime: 'wrong-node' });
    await holder.ready;
    start(holder.child);
    expect(await holder.acquired).toBe(false);
    expect(await holder.deniedCode).toBe('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
    expect(await holder.exit).toEqual({ code: 74, signal: null });
    expect(existsSync(join(dir, 'registry-writer.sqlite'))).toBe(false);
  });

  it('drifted embedded SQLite source id: no acquisition, failure exit', async () => {
    const dir = await makeStateDir('wrong-sqlite');
    const holder = forkHolder(dir, { qualifiedRuntime: 'wrong-sqlite' });
    await holder.ready;
    start(holder.child);
    expect(await holder.acquired).toBe(false);
    expect(await holder.deniedCode).toBe('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
    expect(await holder.exit).toEqual({ code: 74, signal: null });
  });
});

describe('poisoned PATH', () => {
  it('acquires with PATH pointing nowhere — the lease consults no executables', async () => {
    const dir = await makeStateDir('poisoned-path');
    const holder = forkHolder(dir, { env: { ...process.env, PATH: '/astroix-nonexistent' } });
    await holder.ready;
    start(holder.child);
    expect(await holder.acquired).toBe(true);
    holder.child.send({ type: 'shutdown' });
    expect(await holder.exit).toEqual({ code: 0, signal: null });
  });
});
