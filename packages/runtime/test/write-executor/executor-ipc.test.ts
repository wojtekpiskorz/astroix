import { describe, expect, it } from 'vitest';
import {
  EXIT_OK,
  EXIT_PROTOCOL,
  type ExecutorChannel,
  isDomainWritePlan,
  isExecutorWireIn,
  serveWriteExecutor,
} from '../../edit-authority/executor/executor-ipc';
import { createWriteExecutor } from '../../edit-authority/executor/write-executor';
import type { DomainWritePlan } from '../../edit-authority/planning/write-plans';
import { boundResource, digestOf, makeProjectRoot, session } from './executor-harness';

// @vitest-environment node — the serving loop over an in-memory channel; no DOM.
/**
 * The executor wire lane (#224 focused tests, in-process half): the
 * closed inbound union, the hand-rolled domain-plan shape gate, and the
 * serving loop's terminal semantics over an in-memory channel with an
 * injected exit — the same modules the forked children run (the
 * cross-process lease/kill semantics live in executor-process.test.ts).
 */

/** An in-memory private channel: delivered messages, captured sends, manual disconnect. */
interface MemoryChannel extends ExecutorChannel {
  deliver(message: unknown): void;
  sent: unknown[];
  disconnectNow(): void;
}

function memoryChannel(): MemoryChannel {
  const listeners = {
    message: new Set<(message: unknown) => void>(),
    disconnect: new Set<() => void>(),
  };
  let connected = true;
  const channel: MemoryChannel = {
    get connected(): boolean {
      return connected;
    },
    sent: [],
    send: (message) => {
      if (!connected) return false;
      channel.sent.push(message);
      return true;
    },
    on: (event, listener) => {
      if (event === 'message') listeners.message.add(listener as (message: unknown) => void);
      else listeners.disconnect.add(listener as () => void);
      return channel;
    },
    removeListener: (event, listener) => {
      if (event === 'message') listeners.message.delete(listener as (message: unknown) => void);
      else listeners.disconnect.delete(listener as () => void);
      return channel;
    },
    deliver: (message) => {
      for (const listener of listeners.message) listener(message);
    },
    disconnectNow: () => {
      connected = false;
      for (const listener of listeners.disconnect) listener();
    },
  };
  return channel;
}

describe('the closed inbound wire union', () => {
  it('accepts exactly execute (integer id ≥ 0 + plan slot) and stop', () => {
    expect(isExecutorWireIn({ type: 'execute', id: 0, plan: {} })).toBe(true);
    expect(isExecutorWireIn({ type: 'execute', id: 7, plan: null })).toBe(true);
    expect(isExecutorWireIn({ type: 'stop' })).toBe(true);
    expect(isExecutorWireIn({ type: 'execute', id: -1, plan: {} })).toBe(false);
    expect(isExecutorWireIn({ type: 'execute', id: 1.5, plan: {} })).toBe(false);
    expect(isExecutorWireIn({ type: 'execute', id: 1, plan: {}, extra: true })).toBe(false);
    expect(isExecutorWireIn({ type: 'stop', reason: 'x' })).toBe(false);
    expect(isExecutorWireIn({ type: 'unknown' })).toBe(false);
    expect(isExecutorWireIn('execute')).toBe(false);
    expect(isExecutorWireIn(null)).toBe(false);
  });
});

describe('the domain-plan shape gate', () => {
  const base = {
    canonicalRoot: '/canonical/root',
    session: { runtimeEpoch: 'epoch', generation: 1 },
    kind: 'css' as const,
    operations: ['replace-contents'] as const,
    displayPath: 'src/styles/global.css',
    baseline: { type: 'sha256', sha256: digestOf('x') },
    target: { type: 'existing', canonicalPath: '/canonical/root/src/styles/global.css' },
  };

  it('accepts each operation species at its exact field set', () => {
    expect(
      isDomainWritePlan({ operation: 'replace-contents', resource: base, contents: 'next' }),
    ).toBe(true);
    expect(
      isDomainWritePlan({
        operation: 'splice',
        resource: base,
        range: { start: 0, end: 2 },
        replacement: 'ab',
      }),
    ).toBe(true);
    expect(
      isDomainWritePlan({
        operation: 'create-contents',
        resource: { ...base, baseline: { type: 'expected-absent' } },
        contents: 'next',
      }),
    ).toBe(true);
  });

  it('refuses unknown operations, extra fields, and drifted scalars', () => {
    expect(isDomainWritePlan({ operation: 'delete', resource: base })).toBe(false);
    expect(
      isDomainWritePlan({ operation: 'replace-contents', resource: base, contents: 'x', extra: 1 }),
    ).toBe(false);
    expect(isDomainWritePlan({ operation: 'splice', resource: base, range: { start: 0 } })).toBe(
      false,
    );
    expect(
      isDomainWritePlan({ operation: 'splice', resource: base, range: { start: 1.5, end: 2 } }),
    ).toBe(false);
    // Baseline species: sha256 must be lowercase hex; expected-absent carries nothing else.
    expect(
      isDomainWritePlan({
        operation: 'replace-contents',
        resource: { ...base, baseline: { type: 'sha256', sha256: 'not-hex' } },
        contents: 'x',
      }),
    ).toBe(false);
    expect(
      isDomainWritePlan({
        operation: 'replace-contents',
        resource: { ...base, baseline: { type: 'expected-absent', sha256: digestOf('x') } },
        contents: 'x',
      }),
    ).toBe(false);
    // Creation targets: a traversal file name never parses.
    expect(
      isDomainWritePlan({
        operation: 'create-contents',
        resource: {
          ...base,
          baseline: { type: 'expected-absent' },
          target: { type: 'creation', canonicalParent: '/canonical/root', fileName: '../escape' },
        },
        contents: 'x',
      }),
    ).toBe(false);
    // Sessions: a non-positive or fractional generation is not a SessionRef.
    expect(
      isDomainWritePlan({
        operation: 'replace-contents',
        resource: { ...base, session: { runtimeEpoch: 'epoch', generation: 0 } },
        contents: 'x',
      }),
    ).toBe(false);
    expect(isDomainWritePlan(null)).toBe(false);
    expect(isDomainWritePlan(42)).toBe(false);
  });
});

describe('the serving loop (in-memory channel, injected exit)', () => {
  it('announces ready, correlates outcomes by id, and closes on stop', async () => {
    const root = await makeProjectRoot();
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    const channel = memoryChannel();
    const exits: number[] = [];
    serveWriteExecutor({
      channel,
      executor,
      exitProcess: (code) => exits.push(code),
    });
    expect(channel.sent[0]).toEqual({ type: 'ready' });

    // The target does not exist — the honest terminal outcome is the
    // target-absent rejection, correlated back on the wire by id. The
    // outcome involves real filesystem work (realpath), so the wait is a
    // bounded observation poll, never a single-tick assumption.
    channel.deliver({ type: 'execute', id: 3, plan: replacePlanFor(root) });
    const reply = (await waitForReply(channel, 3)) as {
      id?: number;
      outcome?: { type: string; code: string };
    };
    expect(reply?.id).toBe(3);
    expect(reply?.outcome).toEqual({
      type: 'rejected',
      code: 'target-absent',
      message: 'the granted target no longer exists',
    });

    channel.deliver({ type: 'stop' });
    await executor.closed;
    expect(channel.sent.at(-1)).toEqual({
      type: 'closed',
      report: { outcome: 'drained', settled: 1 },
    });
    expect(exits).toEqual([EXIT_OK]);
  });

  it('answers a malformed plan with the malformed-plan rejection, never a crash', async () => {
    const root = await makeProjectRoot();
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    const channel = memoryChannel();
    const exits: number[] = [];
    serveWriteExecutor({ channel, executor, exitProcess: (code) => exits.push(code) });
    channel.deliver({ type: 'execute', id: 1, plan: { operation: 'replace-contents' } });
    const reply = (await waitForReply(channel, 1)) as {
      outcome?: { type: string; code: string };
    } | null;
    expect(reply?.outcome).toEqual({
      type: 'rejected',
      code: 'malformed-plan',
      message: 'the dispatched plan failed the executor\u2019s closed shape validation',
    });
    expect(exits).toEqual([]);
    channel.deliver({ type: 'stop' });
    await executor.closed;
    expect(exits).toEqual([EXIT_OK]);
  });

  it('a wire message outside the closed union drains, then exits 76 — terminal, never guessed at', async () => {
    const root = await makeProjectRoot();
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    const channel = memoryChannel();
    const exits: number[] = [];
    serveWriteExecutor({ channel, executor, exitProcess: (code) => exits.push(code) });
    channel.deliver({ type: 'exfiltrate', path: '/etc/passwd' });
    await executor.closed;
    expect(exits).toEqual([EXIT_PROTOCOL]);
  });

  it('a disconnected control plane drains accepted work, then exits 0', async () => {
    const root = await makeProjectRoot();
    const executor = createWriteExecutor({ canonicalRoot: root, session: session('epoch-a', 1) });
    const channel = memoryChannel();
    const exits: number[] = [];
    serveWriteExecutor({ channel, executor, exitProcess: (code) => exits.push(code) });
    channel.disconnectNow();
    await executor.closed;
    expect(exits).toEqual([EXIT_OK]);
    // The channel was gone before the close report — nothing was sent after death.
    expect(
      channel.sent.filter((message) => (message as { type?: string }).type === 'closed'),
    ).toHaveLength(0);
  });
});

function replacePlanFor(root: string): DomainWritePlan {
  return {
    operation: 'replace-contents',
    resource: boundResource({
      canonicalRoot: root,
      sessionRef: session('epoch-a', 1),
      target: {
        type: 'existing',
        canonicalPath: `${root}/src/styles/global.css`,
        sha256: digestOf('missing'),
      },
    }),
    contents: 'next',
  };
}

/** Awaits the outcome reply for one id — bounded observation polling, never a single-tick assumption. */
async function waitForReply(
  channel: MemoryChannel,
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
