import { type ChildProcess, fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootCapability } from '@wojciechpiskorz/astroix-runtime/private-boot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateRequest,
  bootedReport,
  registerRootRequest,
  type TransitionOutcome,
  transitionResultReport,
} from './child-protocol.ts';

// @vitest-environment node — forks real control-plane children over real private IPC channels; no DOM.
/**
 * The control-plane child's process lane (#243 focused tests): the REAL
 * desktop child entry — capability → kernel registry-writer lease →
 * production registry → the private service loop — forked as raw node
 * with the dev register (the #230/#240 idiom), driven from this test
 * process playing Electron main. The native-grant validation runs the
 * real registry; transitions answer the honest H1 refusal; closing the
 * channel fences and exits the child (D3's contract, observed through
 * the exit event).
 *
 * One SHARED child serves the four request-behavior tests (the TS
 * transform makes each fork expensive — the root run stays kind to the
 * sibling process lanes' timings); the two destructive exits (disconnect
 * fence, no-capability boot protocol) take their own forks.
 */

const CHILD = fileURLToPath(new URL('./control-plane-child.ts', import.meta.url));
const REGISTER = fileURLToPath(new URL('../../raw-node-register.mjs', import.meta.url));
const CHILD_TIMEOUT = 30_000;

const scratchDirs: string[] = [];
const children: ChildProcess[] = [];

let shared: ChildRun;
let grantedDir: string;

beforeAll(async () => {
  grantedDir = await mkdtemp(join(tmpdir(), 'astroix-grant-'));
  scratchDirs.push(grantedDir);
  shared = spawnChild(await freshConfig());
  await shared.booted;
}, CHILD_TIMEOUT);

afterAll(async () => {
  for (const child of children.splice(0)) {
    if (child.connected) child.disconnect();
    child.kill('SIGKILL');
  }
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ChildRun {
  child: ChildProcess;
  reports: unknown[];
  booted: Promise<void>;
  /** Resolves the next report matching a predicate. */
  nextReport<T>(predicate: (report: unknown) => boolean): Promise<T>;
}

function spawnChild(config: Record<string, unknown>): ChildRun {
  const child = fork(CHILD, [JSON.stringify(config)], {
    execArgv: ['--experimental-transform-types', '--import', REGISTER],
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  children.push(child);
  const reports: unknown[] = [];
  const waiters: Array<{ predicate: (report: unknown) => boolean; resolve: (r: unknown) => void }> =
    [];
  child.on('message', (message: unknown) => {
    reports.push(message);
    for (let index = 0; index < waiters.length; index += 1) {
      if (waiters[index]?.predicate(message)) {
        const waiter = waiters.splice(index, 1)[0];
        waiter?.resolve(message);
        index -= 1;
      }
    }
  });
  const run: ChildRun = {
    child,
    reports,
    booted: new Promise((resolve) => {
      child.on('message', (message: unknown) => {
        if ((message as Record<string, unknown> | null)?.kind === 'booted') resolve();
      });
    }),
    nextReport: <T>(predicate: (report: unknown) => boolean) =>
      new Promise<T>((resolve) => {
        const already = reports.find((report) => predicate(report));
        if (already !== undefined) {
          resolve(already as T);
          return;
        }
        waiters.push({ predicate, resolve: (report) => resolve(report as T) });
      }),
  };
  // The one-use capability: minted here (main side), first message.
  child.send(BootCapability.mint().toWireMessage());
  return run;
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

/** One report is private-channel traffic when it carries the channel's own tag. */
function isPrivateReport(report: unknown): boolean {
  return (
    typeof report === 'object' &&
    report !== null &&
    (report as Record<string, unknown>).astroix === 'astroix.desktop-private-channel'
  );
}

async function freshConfig(): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), 'astroix-desktop-child-'));
  scratchDirs.push(root);
  return {
    privateStateDirectory: join(root, 'private-state'),
    registryDirectory: join(root, 'registry'),
    declareCurrentRuntimePin: true,
  };
}

describe('the control-plane child (process lane)', () => {
  it(
    'validates a native directory grant with a sanitized reply — no root ever echoes back',
    async () => {
      shared.child.send(registerRootRequest(1, grantedDir));
      const reply = await shared.nextReport<{
        kind: string;
        requestId: number;
        result: { ok: boolean; summary?: Record<string, unknown> };
      }>((report) => isPrivateReport(report) && (report as { requestId?: number }).requestId === 1);
      expect(reply.kind).toBe('register-result');
      expect(reply.result.ok).toBe(true);
      expect(reply.result.summary).toMatchObject({
        displayName: expect.any(String),
        availability: 'available',
        projectKey: expect.any(String),
      });
      expect(JSON.stringify(reply)).not.toContain(grantedDir);
    },
    CHILD_TIMEOUT,
  );

  it(
    'refuses an unavailable root with the sanitized registry code',
    async () => {
      shared.child.send(registerRootRequest(2, '/definitely/not/an/existing/root'));
      const reply = await shared.nextReport<{ result: { ok: boolean; code: string } }>(
        (report) => (report as { requestId?: number }).requestId === 2,
      );
      expect(reply.result).toEqual({ ok: false, code: 'root-unavailable' });
    },
    CHILD_TIMEOUT,
  );

  it(
    'answers the settled refusal for delegated transitions (the H1 composition boundary)',
    async () => {
      shared.child.send(activateRequest(3, 'someprojectkey'));
      const reply = await shared.nextReport<{ outcome: TransitionOutcome }>(
        (report) => (report as { requestId?: number }).requestId === 3,
      );
      expect(reply.outcome).toEqual({ kind: 'refused', reason: 'unavailable-composition' });
      expect(transitionResultReport(0, reply.outcome).kind).toBe('transition-result');
    },
    CHILD_TIMEOUT,
  );

  it(
    'ignores a drifted message and keeps serving (fail-closed drop, not a parse)',
    async () => {
      shared.child.send({ astroix: 'some-other-protocol', kind: 'register-root', requestId: 9 });
      shared.child.send(registerRootRequest(4, '/definitely/not/here'));
      const reply = await shared.nextReport<{ requestId: number }>(
        (report) => (report as { requestId?: number }).requestId === 4,
      );
      expect(reply.requestId).toBe(4);
    },
    CHILD_TIMEOUT,
  );

  it(
    'fences and exits when the private channel closes (the D3 disconnect contract)',
    async () => {
      const run = spawnChild(await freshConfig());
      await run.booted;
      expect(bootedReport().kind).toBe('booted');
      const exited = exitOf(run.child);
      run.child.disconnect();
      const outcome = await exited;
      expect(outcome.code).toBe(0); // EXIT_FENCED: authority ended normally with the channel
      expect(outcome.signal).toBeNull();
    },
    CHILD_TIMEOUT,
  );

  it(
    'dies with the boot-protocol exit when no capability is conferred',
    async () => {
      const child = fork(CHILD, [JSON.stringify(await freshConfig())], {
        execArgv: ['--experimental-transform-types', '--import', REGISTER],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      const exited = exitOf(child);
      // main never sends the capability; the channel closes instead
      setTimeout(() => child.disconnect(), 30);
      const outcome = await exited;
      expect(outcome.code).toBe(76); // EXIT_BOOT_PROTOCOL
    },
    CHILD_TIMEOUT,
  );
});
