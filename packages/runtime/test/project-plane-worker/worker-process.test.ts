import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// @vitest-environment node — forks real children from real file paths; no DOM.
/**
 * The #230 process lane: the real boot gate, serving loop, typed wire,
 * and terminal exit semantics over real forked children with real IPC
 * channels and the real `process.exit` — the dispatch-boundary fake
 * plane standing in for the composition runtime (whose truth is the
 * certification suite). Crash is terminal and never auto-restarts: a
 * protocol-violation crash runs cleanup before the exit, a SIGKILLed
 * child stays dead, and the boot marker never increments twice. The
 * forked children load the same product modules the packaged runtime
 * will, bridged by the extensionless resolve hook (the bundler context
 * stand-in — see raw-node-register.mjs).
 */

const CHILD = fileURLToPath(new URL('./worker-child-runner.ts', import.meta.url));
const REGISTER = fileURLToPath(new URL('./raw-node-register.mjs', import.meta.url));

const children: ChildProcess[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.connected) child.disconnect();
    child.kill('SIGKILL');
  }
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeMarkerDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astroix-ppw-'));
  scratchDirs.push(dir);
  return dir;
}

interface WireOut {
  type: string;
  id?: number;
  ok?: boolean;
  result?: { kind: string; revision: number };
  failure?: { code: string; message: string; adapterCode?: string | null };
  report?: { outcome: string; failures: string[] };
  event?: { type: string };
}

interface SpawnedWorker {
  child: ChildProcess;
  markerDir: string;
  /** Resolves on the next message matching the predicate (deadline-bounded). */
  next: (predicate: (message: WireOut) => boolean, what: string) => Promise<WireOut>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnWorker(config: Record<string, unknown>): Promise<SpawnedWorker> {
  const child = fork(CHILD, [JSON.stringify(config)], {
    execArgv: ['--import', REGISTER],
    stdio: 'ignore',
  });
  children.push(child);
  const pending: Array<{
    predicate: (message: WireOut) => boolean;
    what: string;
    resolve: (message: WireOut) => void;
  }> = [];
  const queue: WireOut[] = [];
  child.on('message', (message: unknown) => {
    const wire = message as WireOut;
    const index = pending.findIndex((entry) => entry.predicate(wire));
    if (index >= 0) {
      const [entry] = pending.splice(index, 1);
      entry?.resolve(wire);
    } else {
      queue.push(wire);
    }
  });
  const next = (predicate: (message: WireOut) => boolean, what: string): Promise<WireOut> => {
    const index = queue.findIndex(predicate);
    if (index >= 0) {
      const [message] = queue.splice(index, 1);
      return Promise.resolve(message as WireOut);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for: ${what}`)), 20_000);
      pending.push({
        predicate,
        what,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return Promise.resolve({ child, markerDir: config.markerDir as string, next, exit });
}

async function bootMarkerLines(markerDir: string): Promise<number> {
  try {
    return (await readFile(join(markerDir, 'boot.marker'), 'utf8')).trim().split('\n').length;
  } catch {
    return 0;
  }
}

describe('the exact worker child', () => {
  it('boots the plane, serves a typed inspection, and answers with the revisioned result', async () => {
    const markerDir = await makeMarkerDir();
    const worker = await spawnWorker({ markerDir });

    worker.child.send({ type: 'inspect', id: 1, request: { kind: 'project' } });
    const answer = await worker.next(
      (m) => m.type === 'inspect-result' && m.id === 1,
      'project result',
    );
    expect(answer.ok).toBe(true);
    expect(answer.result).toEqual({
      kind: 'project',
      revision: 1,
      payload: { certified: { astro: '7.2.10', vite: '8.2.2' } },
    });
    expect(await bootMarkerLines(markerDir)).toBe(1);

    worker.child.send({ type: 'stop' });
    const closed = await worker.next((m) => m.type === 'closed', 'close report');
    expect(closed.report?.outcome).toBe('complete');
    expect(await worker.exit).toEqual({ code: 0, signal: null });
    expect(existsSync(join(markerDir, 'plane-closed.marker'))).toBe(true);
  });

  it('a boot failure is terminal: exit 74, no boot marker, no serving', async () => {
    const markerDir = await makeMarkerDir();
    const worker = await spawnWorker({ markerDir, planeBoot: 'fail' });
    expect(await worker.exit).toEqual({ code: 74, signal: null });
    expect(await bootMarkerLines(markerDir)).toBe(0);
    expect(existsSync(join(markerDir, 'plane-closed.marker'))).toBe(false);
  });
});

describe('adapter branch failure propagation across the process boundary', () => {
  it('an adapter failure arrives as a structured sanitized failure — the worker stays alive', async () => {
    const markerDir = await makeMarkerDir();
    const worker = await spawnWorker({ markerDir, behaviors: { content: 'adapter' } });

    worker.child.send({ type: 'inspect', id: 5, request: { kind: 'content' } });
    const failure = await worker.next((m) => m.type === 'inspect-result' && m.id === 5, 'failure');
    expect(failure.ok).toBe(false);
    expect(failure.failure?.code).toBe('inspection-failed');
    expect(failure.failure?.adapterCode).toBe('seam-rejected');
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain('/Users');
    expect(serialized).not.toContain('pid');
    expect(serialized).not.toContain('stack');

    // Alive: a later inspection still answers.
    worker.child.send({ type: 'inspect', id: 6, request: { kind: 'routes' } });
    const next = await worker.next((m) => m.type === 'inspect-result' && m.id === 6, 'recovery');
    expect(next.ok).toBe(true);

    worker.child.send({ type: 'stop' });
    await worker.exit;
  });

  it('an unexpected branch error arrives as the generic failure — the raw message never crosses', async () => {
    const markerDir = await makeMarkerDir();
    const worker = await spawnWorker({ markerDir, behaviors: { styles: 'raw-throw' } });

    worker.child.send({
      type: 'inspect',
      id: 1,
      request: { kind: 'styles', routeComponent: 'src/pages/index.astro' },
    });
    const failure = await worker.next((m) => m.type === 'inspect-result' && m.id === 1, 'failure');
    expect(failure.failure?.code).toBe('inspection-failed');
    expect(failure.failure?.message).toBe('the styles inspection failed unexpectedly');
    expect(JSON.stringify(failure)).not.toContain('/Users/secret');

    worker.child.send({ type: 'stop' });
    await worker.exit;
  });

  it('a malformed request is answered with the typed failure, not a crash', async () => {
    const markerDir = await makeMarkerDir();
    const worker = await spawnWorker({ markerDir });

    worker.child.send({ type: 'inspect', id: 1, request: { kind: 'project', path: '/etc' } });
    const failure = await worker.next((m) => m.type === 'inspect-result' && m.id === 1, 'failure');
    expect(failure.failure?.code).toBe('malformed-request');

    worker.child.send({ type: 'stop' });
    expect((await worker.exit).code).toBe(0);
  });
});

describe('terminal crash — cleanup before exit, never a restart', () => {
  it('a wire protocol violation closes the plane, reports, then exits 76', async () => {
    const markerDir = await makeMarkerDir();
    const worker = await spawnWorker({ markerDir });

    worker.child.send({ type: 'inspect', id: 1, request: { kind: 'project' } });
    await worker.next((m) => m.type === 'inspect-result' && m.id === 1, 'warmup');

    worker.child.send({ type: 'import-module', specifier: 'node:fs' });
    const closed = await worker.next((m) => m.type === 'closed', 'close report');
    expect(closed.report?.outcome).toBe('complete'); // cleanup still completed
    expect(await worker.exit).toEqual({ code: 76, signal: null });
    expect(existsSync(join(markerDir, 'plane-closed.marker'))).toBe(true);

    // The exit is terminal: the child never boots again on its own.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await bootMarkerLines(markerDir)).toBe(1);
  }, 25_000);

  it('a SIGKILLed child stays dead — no respawn, no second boot', async () => {
    const markerDir = await makeMarkerDir();
    const worker = await spawnWorker({ markerDir });
    worker.child.send({ type: 'inspect', id: 1, request: { kind: 'project' } });
    await worker.next((m) => m.type === 'inspect-result' && m.id === 1, 'warmup');
    expect(await bootMarkerLines(markerDir)).toBe(1);

    worker.child.kill('SIGKILL');
    expect(await worker.exit).toEqual({ code: null, signal: 'SIGKILL' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await bootMarkerLines(markerDir)).toBe(1); // exactly one boot, ever
  }, 25_000);

  it('a disconnecting parent fences the child: cleanup, then clean exit', async () => {
    const markerDir = await makeMarkerDir();
    const worker = await spawnWorker({ markerDir });
    worker.child.send({ type: 'inspect', id: 1, request: { kind: 'project' } });
    await worker.next((m) => m.type === 'inspect-result' && m.id === 1, 'warmup');

    worker.child.disconnect();
    expect(await worker.exit).toEqual({ code: 0, signal: null });
    expect(existsSync(join(markerDir, 'plane-closed.marker'))).toBe(true);
  });
});
