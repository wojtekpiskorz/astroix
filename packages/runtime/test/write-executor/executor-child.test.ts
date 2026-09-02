import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bootWriteExecutorChild,
  parseExecutorChildConfig,
} from '../../edit-authority/executor/executor-child';
import type { ExecutorChannel } from '../../edit-authority/executor/executor-ipc';
import {
  createKernelLeaseModule,
  currentRuntimePin,
  KernelLeaseError,
} from '../../kernel-lease/kernel-lease';
import { boundResource, digestOf, makeDir, makeProjectRoot, session } from './executor-harness';

// @vitest-environment node — a real edit-writer lease over a real temp state dir; no DOM.
/**
 * The child boot lane (#224 focused tests, in-process half): the
 * lease-before-anything boot order against a real kernel edit-writer
 * lease — the success path serves the real executor core over an
 * injected memory channel, and the contention path proves a boot that
 * cannot take the lease exits through the #222 discipline (73) without
 * ever building or serving an executor. The forked-child composition
 * over the real channel runs in executor-process.test.ts; these units
 * hold the same-module boot gate the process lane forks.
 */

describe('bootWriteExecutorChild', () => {
  it('takes the lease, builds the real executor, and serves it — the happy boot', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'astroix-wx-child-'));
    const root = await makeProjectRoot();
    await makeDir(root, 'src/styles');
    const channel = memoryChannel();
    const exits: number[] = [];

    await bootWriteExecutorChild({
      channel,
      privateStateDirectory: stateDir,
      canonicalRoot: root,
      session: session('epoch-a', 1),
      qualifiedRuntime: currentRuntimePin(),
      exitProcess: (code) => exits.push(code),
    });
    expect(exits).toEqual([]);
    expect(channel.sent[0]).toEqual({ type: 'ready' });

    // The served executor is the real core: this hand-bound plan rejects
    // cross-session through the same fact checks (session bound to gen 2).
    channel.deliver({
      type: 'execute',
      id: 1,
      plan: {
        operation: 'replace-contents',
        resource: boundResource({
          canonicalRoot: root,
          sessionRef: session('epoch-a', 2),
          target: {
            type: 'existing',
            canonicalPath: join(root, 'src/styles/global.css'),
            sha256: digestOf('x'),
          },
        }),
        contents: 'next',
      },
    });
    await waitForReply(channel, 1);
    channel.deliver({ type: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual([0]);
  });

  it('a boot that cannot take the lease exits 73 and never serves — contention is never a guess', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'astroix-wx-child-'));
    // A live holder in this same process: the kernel keeps the file
    // exclusive even across same-process connections (the #209 proof).
    createKernelLeaseModule({
      privateStateDirectory: stateDir,
      qualifiedRuntime: currentRuntimePin(),
    }).holdEditWriter();

    const channel = memoryChannel();
    const exits: number[] = [];
    const boot = bootWriteExecutorChild({
      channel,
      privateStateDirectory: stateDir,
      canonicalRoot: await makeProjectRoot(),
      session: session('epoch-a', 1),
      qualifiedRuntime: currentRuntimePin(),
      exitProcess: (code) => exits.push(code),
    });
    await expect(boot).rejects.toBeInstanceOf(KernelLeaseError);
    expect(exits).toEqual([73]);
    // Nothing was ever built or served: no ready, no outcome, no exit 0.
    expect(channel.sent).toEqual([]);
  });
});

describe('parseExecutorChildConfig', () => {
  it('lifts a well-formed argv JSON and refuses everything else', () => {
    const config = parseExecutorChildConfig(
      JSON.stringify({
        privateStateDirectory: '/state',
        canonicalRoot: '/root',
        session: { runtimeEpoch: 'e', generation: 1 },
      }),
    );
    expect(config).toEqual({
      privateStateDirectory: '/state',
      canonicalRoot: '/root',
      session: { runtimeEpoch: 'e', generation: 1 },
    });
    expect(parseExecutorChildConfig('not json')).toBeNull();
    expect(parseExecutorChildConfig(undefined)).toBeNull();
    expect(
      parseExecutorChildConfig(JSON.stringify({ privateStateDirectory: '/state' })),
    ).toBeNull();
  });
});

/** An in-memory private channel: delivered messages, captured sends. */
function memoryChannel(): ExecutorChannel & { deliver(message: unknown): void; sent: unknown[] } {
  const listeners = new Set<(message: unknown) => void>();
  const channel = {
    connected: true,
    sent: [] as unknown[],
    send: (message: unknown) => {
      channel.sent.push(message);
      return true;
    },
    on: (event: 'message' | 'disconnect', listener: unknown) => {
      if (event === 'message') listeners.add(listener as (message: unknown) => void);
      return channel;
    },
    removeListener: (event: 'message' | 'disconnect', listener: unknown) => {
      if (event === 'message') listeners.delete(listener as (message: unknown) => void);
      return channel;
    },
    deliver: (message: unknown) => {
      for (const listener of listeners) listener(message);
    },
  };
  return channel;
}

/** Awaits the outcome reply for one id — bounded observation polling. */
async function waitForReply(
  channel: { sent: unknown[] },
  id: number,
  timeoutMs = 5_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = channel.sent.find(
      (message) =>
        (message as { type?: string; id?: number }).type === 'outcome' &&
        (message as { id?: number }).id === id,
    );
    if (reply !== undefined) return reply;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for the outcome reply (id ${id})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
