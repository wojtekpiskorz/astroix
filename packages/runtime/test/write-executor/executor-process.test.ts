import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  spawnWriteExecutor,
  type WriteExecutorHandle,
} from '../../edit-authority/executor/executor-spawn';
import { ExecutorFencedError } from '../../edit-authority/executor/write-outcomes';
import type { DomainWritePlan } from '../../edit-authority/planning/write-plans';
import { currentRuntimePin } from '../../kernel-lease/kernel-lease';
import {
  cssReplacePlan,
  digestOf,
  makeDir,
  makeProjectRoot,
  openTable,
  session,
} from './executor-harness';

// @vitest-environment node — forks real children from real file paths; no DOM.
/**
 * The write-executor process lane (#224 focused tests): real forked
 * children over real private IPC channels and real kernel edit-writer
 * leases — asserted on wire messages, exit events, and file bytes, never
 * timing. The lease law this lane owns: a session's executor holds the
 * app-global edit-writer lease from boot until its exit; a staged
 * candidate's executor fails closed while any live executor holds
 * (contention exit 73, no serving, no writes); the exit — graceful drain
 * or forced kill — is the transfer; and a forced exit racing accepted
 * work reports the honest `unknown` outcome, never a guess.
 */

const RUNNER = fileURLToPath(new URL('./executor-child-runner.ts', import.meta.url));
const CSS = '.hero { color: red; }\n';
const NEXT = '.hero { color: blue; }\n';

const scratchDirs: string[] = [];
const handles: WriteExecutorHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.kill();
  }
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStateDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `astroix-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

async function makeProject(): Promise<{ root: string; plan: DomainWritePlan }> {
  const root = await makeProjectRoot();
  await makeDir(root, 'src/styles');
  await writeFile(join(root, 'src/styles/global.css'), CSS, 'utf8');
  const table = await openTable(root);
  const plan = await cssReplacePlan(
    table,
    session('epoch-a', 1),
    'src/styles/global.css',
    CSS,
    NEXT,
  );
  return { root, plan };
}

function spawnExecutor(input: {
  privateStateDirectory: string;
  canonicalRoot: string;
  gateDir?: string;
}): WriteExecutorHandle {
  const handle = spawnWriteExecutor({
    privateStateDirectory: input.privateStateDirectory,
    canonicalRoot: input.canonicalRoot,
    session: session('epoch-a', 1),
    qualifiedRuntime: currentRuntimePin(),
    childModule: RUNNER,
    childConfig: input.gateDir === undefined ? undefined : { gateDir: input.gateDir },
  });
  handles.push(handle);
  return handle;
}

/** Waits for a gate marker with a deadline — observation polling, never a timing assertion (#222 idiom). */
async function waitForMarker(gateDir: string, name: string, timeoutMs = 10_000): Promise<void> {
  const path = join(gateDir, `${name}.marker`);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the ${name} marker`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the exact executor child', () => {
  it('boots, holds the lease, serves a real write, and releases on the drained exit', async () => {
    const stateDir = await makeStateDir('serve');
    const { root, plan } = await makeProject();

    const executor = spawnExecutor({ privateStateDirectory: stateDir, canonicalRoot: root });
    await executor.ready;
    const outcome = await executor.execute(plan);
    expect(outcome).toEqual({ type: 'committed', revision: digestOf(NEXT) });
    expect(await readFile(join(root, 'src/styles/global.css'), 'utf8')).toBe(NEXT);

    await executor.stop();
    expect(await executor.exited).toEqual({ code: 0, signal: null });

    // The exit was the release: a successor executor acquires the lease.
    const successor = spawnExecutor({ privateStateDirectory: stateDir, canonicalRoot: root });
    await successor.ready;
    await successor.stop();
    expect(await successor.exited).toEqual({ code: 0, signal: null });
  }, 25_000);

  it('work submitted after stop was never dispatched — ExecutorFencedError', async () => {
    const stateDir = await makeStateDir('fence');
    const { root, plan } = await makeProject();
    const executor = spawnExecutor({ privateStateDirectory: stateDir, canonicalRoot: root });
    await executor.ready;
    const stopping = executor.stop();
    await expect(executor.execute(plan)).rejects.toBeInstanceOf(ExecutorFencedError);
    await stopping;
    await executor.exited;
    expect(await readFile(join(root, 'src/styles/global.css'), 'utf8')).toBe(CSS);
  }, 25_000);
});

describe('staged candidates stay fenced — the lease is the fence', () => {
  it('a candidate executor fails closed while the active executor holds the edit-writer lease', async () => {
    const stateDir = await makeStateDir('candidate');
    const activeProject = await makeProject();
    const candidateProject = await makeProject();

    const active = spawnExecutor({
      privateStateDirectory: stateDir,
      canonicalRoot: activeProject.root,
    });
    await active.ready;

    // The candidate (a different session's executor over the same private
    // state) cannot obtain the lease: contention exit 73, no ready, no
    // serving, and its plan was never dispatched by anyone.
    const candidate = spawnExecutor({
      privateStateDirectory: stateDir,
      canonicalRoot: candidateProject.root,
    });
    await expect(candidate.ready).rejects.toThrow(/exited before it was ready/);
    expect(await candidate.exited).toEqual({ code: 73, signal: null });

    // The active executor still owns the write path — its plan commits.
    expect(await active.execute(activeProject.plan)).toEqual({
      type: 'committed',
      revision: digestOf(NEXT),
    });

    // The active executor's exit is the transfer: the next session acquires.
    await active.stop();
    expect(await active.exited).toEqual({ code: 0, signal: null });
    const successor = spawnExecutor({
      privateStateDirectory: stateDir,
      canonicalRoot: candidateProject.root,
    });
    await successor.ready;
    await successor.stop();
    expect(await successor.exited).toEqual({ code: 0, signal: null });
  }, 30_000);
});

describe('forced exit and the unknown write outcome', () => {
  it('a SIGKILL racing accepted work reports unknown — never a guess — and death releases the lease', async () => {
    const stateDir = await makeStateDir('force');
    const gateDir = await makeStateDir('force-gate');
    const { root, plan } = await makeProject();

    const executor = spawnExecutor({
      privateStateDirectory: stateDir,
      canonicalRoot: root,
      gateDir,
    });
    await executor.ready;

    // The operation is dispatched and provably IN FLIGHT (the gate
    // marker) before the kill races it. With the gate held the file is
    // deterministically still the old bytes — and the seam still reports
    // `unknown`, because the spawner cannot know how far a killed
    // executor got in production, where death strikes anywhere.
    const inFlight = executor.execute(plan);
    await waitForMarker(gateDir, 'executing-1');

    const killed = executor.kill();
    const outcome = await inFlight;
    expect(outcome).toEqual({ type: 'unknown' });
    await killed;
    expect(await executor.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(existsSync(join(gateDir, 'passed-1.marker'))).toBe(false);
    expect(await readFile(join(root, 'src/styles/global.css'), 'utf8')).toBe(CSS);

    // The forced death released the lease: a successor acquires.
    const successor = spawnExecutor({ privateStateDirectory: stateDir, canonicalRoot: root });
    await successor.ready;
    await successor.stop();
    expect(await successor.exited).toEqual({ code: 0, signal: null });
  }, 30_000);

  it('a graceful stop drains accepted work: the terminal outcome lands before the close and the exit', async () => {
    const stateDir = await makeStateDir('drain');
    const { root, plan } = await makeProject();

    const executor = spawnExecutor({ privateStateDirectory: stateDir, canonicalRoot: root });
    await executor.ready;

    // The execute and the stop are channel-ordered: the operation is
    // core-admitted before the stop control arrives, so the drain owns
    // it — its terminal outcome is reported first, and only then does the
    // executor close and exit (the lease release).
    const inFlight = executor.execute(plan);
    const stopping = executor.stop();
    expect(await inFlight).toEqual({ type: 'committed', revision: digestOf(NEXT) });
    await stopping;
    expect(await executor.exited).toEqual({ code: 0, signal: null });
    expect(await readFile(join(root, 'src/styles/global.css'), 'utf8')).toBe(NEXT);
  }, 25_000);
});
