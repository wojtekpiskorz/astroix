import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { AdapterError } from '../../astro-project-adapter/adapter-error';
import { withFreshRunner } from '../../astro-project-adapter/fresh-runner';

/**
 * Fresh-runner accounting (#225): the wrapper's own discipline — close in
 * `finally`, prove closed, prove the hot transport's `send` listener
 * count restored. These units exercise the ACCOUNTING with injected
 * stand-ins (the wrapper's own contract); the real Vite runner behavior
 * behind it is proven by the certification suite over the certified
 * install — the behavior layer is never faked as a compatibility claim.
 */

interface FakeHarness {
  readonly environment: unknown;
  readonly emitter: EventEmitter;
  readonly createServerModuleRunner: (environment: unknown) => unknown;
  readonly runners: FakeRunner[];
}

/**
 * A fake runner that mirrors the real pin discipline by IDENTITY (#386):
 * the constructor pins its send listeners, and `close()` removes exactly
 * those functions — the certified Vite's transport stores its handler and
 * `off`s that same reference, which positional removal would not mirror
 * once two runners share one emitter.
 */
class FakeRunner {
  closed = false;
  readonly pinnedListeners: Array<() => void> = [];

  constructor(
    private readonly emitter: EventEmitter,
    private readonly behavior: { readonly surviveClose?: boolean } = {},
  ) {
    for (let i = 0; i < 3; i += 1) {
      const listener = (): void => {};
      this.pinnedListeners.push(listener);
      this.emitter.on('send', listener);
    }
  }

  async import(): Promise<unknown> {
    return {};
  }

  async close(): Promise<void> {
    if (this.behavior.surviveClose) return;
    for (const listener of this.pinnedListeners) {
      this.emitter.removeListener('send', listener);
    }
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function harness(behavior?: { readonly surviveClose?: boolean }): FakeHarness {
  const emitter = new EventEmitter();
  const runners: FakeRunner[] = [];
  return {
    emitter,
    runners,
    environment: {
      moduleGraph: { getModuleById: () => null },
      pluginContainer: { resolveId: async () => null },
      hot: { api: { outsideEmitter: emitter } },
    },
    createServerModuleRunner: () => {
      const runner = new FakeRunner(emitter, behavior);
      runners.push(runner);
      return runner;
    },
  };
}

describe('withFreshRunner', () => {
  it('closes the runner after a passing inspection and proves no residue', async () => {
    const fake = harness();
    const outcome = await withFreshRunner(
      { createServerModuleRunner: fake.createServerModuleRunner, ssrEnvironment: fake.environment },
      async (runner) => `inspected-with-${runner.isClosed()}`,
    );
    expect(outcome.result).toBe('inspected-with-false');
    // The pass started with a clean transport (0), the runner pinned 3
    // listeners during construction, and close() restored the count —
    // the accounting evidence records exactly that restoration.
    expect(outcome.evidence).toEqual({
      sendListenersBefore: 0,
      sendListenersAfterClose: 0,
      closedAfterClose: true,
    });
    expect(fake.emitter.listenerCount('send')).toBe(0);
  });

  it('closes the runner in finally when the inspection throws, then rethrows', async () => {
    const fake = harness();
    await expect(
      withFreshRunner(
        {
          createServerModuleRunner: fake.createServerModuleRunner,
          ssrEnvironment: fake.environment,
        },
        async () => {
          throw new Error('inspection failed');
        },
      ),
    ).rejects.toThrow('inspection failed');
    expect(fake.runners[0]?.isClosed()).toBe(true);
    expect(fake.emitter.listenerCount('send')).toBe(0);
  });

  it('rejects as runner-cleanup when the runner survives close', async () => {
    const fake = harness({ surviveClose: true });
    await expect(
      withFreshRunner(
        {
          createServerModuleRunner: fake.createServerModuleRunner,
          ssrEnvironment: fake.environment,
        },
        async () => 'ok',
      ),
    ).rejects.toMatchObject({
      code: 'runner-cleanup',
      details: { residue: 'open-runner' },
    });
  });

  it('still proves residue when the inspection itself failed — both surface', async () => {
    // The residue proof runs on every exit path: a failed inspection plus
    // a surviving runner is an AggregateError carrying both, so neither
    // the failure nor the leak can hide the other (and a leak on a failed
    // pass never becomes the next pass's accounting baseline).
    const fake = harness({ surviveClose: true });
    let rejection: unknown;
    try {
      await withFreshRunner(
        {
          createServerModuleRunner: fake.createServerModuleRunner,
          ssrEnvironment: fake.environment,
        },
        async () => {
          throw new Error('inspection failed');
        },
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AggregateError);
    const aggregate = rejection as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message).toBe('inspection failed');
    expect(aggregate.errors[1]).toMatchObject({ code: 'runner-cleanup' });
  });

  it('rejects as runner-cleanup when close itself rejects after a failed inspection', async () => {
    const fake = harness();
    const failingClose = {
      ssrEnvironment: fake.environment,
      createServerModuleRunner: () => ({
        import: async () => ({}),
        close: async () => {
          throw new Error('close exploded');
        },
        isClosed: () => true,
      }),
    };
    // No residue here (closed, listeners restored): the aggregate message
    // must not claim residue it did not find — it names the cleanup failure.
    const rejection = await withFreshRunner(failingClose, async () => {
      throw new Error('inspection failed');
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).message).not.toContain('residue');
    expect((rejection as AggregateError).message).toContain('the runner cleanup failed');
  });

  it('carries a close rejection as the cause of a residue error', async () => {
    const emitter = new EventEmitter();
    const environment = {
      moduleGraph: { getModuleById: () => null },
      pluginContainer: { resolveId: async () => null },
      hot: { api: { outsideEmitter: emitter } },
    };
    // close() both explodes AND leaves the runner open: the residue
    // rejection keeps the close rejection as its cause — the rejection
    // that likely explains the residue is never dropped.
    const rejection = await withFreshRunner(
      {
        ssrEnvironment: environment,
        createServerModuleRunner: () => ({
          import: async () => ({}),
          close: async () => {
            throw new Error('close exploded');
          },
          isClosed: () => false,
        }),
      },
      async () => 'ok',
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      code: 'runner-cleanup',
      details: { residue: 'open-runner' },
    });
    expect((rejection as AdapterError).cause).toBeInstanceOf(Error);
    expect(((rejection as AdapterError).cause as Error).message).toBe('close exploded');
  });

  it('rejects as runner-cleanup when send listeners leak across the pass', async () => {
    const emitter = new EventEmitter();
    const environment = {
      moduleGraph: { getModuleById: () => null },
      pluginContainer: { resolveId: async () => null },
      hot: { api: { outsideEmitter: emitter } },
    };
    await expect(
      withFreshRunner(
        {
          ssrEnvironment: environment,
          createServerModuleRunner: () => ({
            import: async () => ({}),
            close: async () => {
              emitter.on('send', () => {});
            },
            isClosed: () => true,
          }),
        },
        async () => 'ok',
      ),
    ).rejects.toMatchObject({
      code: 'runner-cleanup',
      details: { residue: 'send-listeners', before: 0, after: 1 },
    });
  });

  it('fails closed before creating a runner when the environment shape drifted', async () => {
    await expect(
      withFreshRunner(
        { createServerModuleRunner: () => ({}), ssrEnvironment: { moduleGraph: null } },
        async () => 'ok',
      ),
    ).rejects.toMatchObject({ code: 'seam-rejected' });
  });

  it('proves no residue across repeated fresh runners over one environment', async () => {
    const fake = harness();
    for (let pass = 1; pass <= 3; pass += 1) {
      const outcome = await withFreshRunner(
        {
          createServerModuleRunner: fake.createServerModuleRunner,
          ssrEnvironment: fake.environment,
        },
        async () => pass,
      );
      expect(outcome.evidence.sendListenersAfterClose).toBe(outcome.evidence.sendListenersBefore);
      expect(outcome.evidence.closedAfterClose).toBe(true);
    }
    expect(fake.runners).toHaveLength(3);
  });
});

// ——— concurrent passes over the ONE composition transport (#386) ———
//
// The worker serves inspections concurrently, and a cancelled HTTP
// dispatch still runs to completion server-side, so two fresh-runner
// passes legitimately overlap on the same SSR environment. These legs
// pin the deterministic interleavings of that overlap — the exact
// shapes that tripped the retired shared-count proof (a sibling's
// in-flight listener polluting the count in either direction) — and
// prove the per-pass proof keeps its teeth under the same overlap.

/** A manually-settled gate one pass's inspection body pends on. */
function defer(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('withFreshRunner (concurrent passes over one transport, #386)', () => {
  it('proves both passes clean when a sibling is still in flight at the after-close read', async () => {
    // The issue's first trigger shape: pass A closes while pass B's runner
    // is still open — A's after-close transport state contains B's pinned
    // listener. The shared-count proof read `after: 3, before: 0` and
    // rejected A as residue; the per-pass proof attributes B's listener to
    // B and proves A's own pinned listeners gone.
    const fake = harness();
    const aGate = defer();
    const bGate = defer();
    const passA = withFreshRunner(
      { createServerModuleRunner: fake.createServerModuleRunner, ssrEnvironment: fake.environment },
      async () => aGate.promise.then(() => 'a'),
    );
    const passB = withFreshRunner(
      { createServerModuleRunner: fake.createServerModuleRunner, ssrEnvironment: fake.environment },
      async () => bGate.promise.then(() => 'b'),
    );
    aGate.resolve();
    await expect(passA).resolves.toMatchObject({ result: 'a' });
    bGate.resolve();
    await expect(passB).resolves.toMatchObject({ result: 'b' });
    expect(fake.emitter.listenerCount('send')).toBe(0);
  });

  it('proves a pass clean when siblings pinned before it all close during its body', async () => {
    // The issue's pile-up direction (`before: 40, after: 3`): the pass
    // starts with siblings' listeners in its baseline and they unwind while
    // its own inspection body runs — the count DROPS across the pass, which
    // the shared-count proof read as residue.
    const fake = harness();
    const gates = [defer(), defer(), defer()];
    const siblings = gates.map((gate) =>
      withFreshRunner(
        {
          createServerModuleRunner: fake.createServerModuleRunner,
          ssrEnvironment: fake.environment,
        },
        async () => gate.promise.then(() => 'sibling'),
      ),
    );
    const lateGate = defer();
    const late = withFreshRunner(
      { createServerModuleRunner: fake.createServerModuleRunner, ssrEnvironment: fake.environment },
      async () => lateGate.promise.then(() => 'late'),
    );
    for (const gate of gates) gate.resolve();
    await Promise.all(siblings);
    lateGate.resolve();
    const outcome = await late;
    expect(outcome.result).toBe('late');
    expect(outcome.evidence.closedAfterClose).toBe(true);
    expect(fake.emitter.listenerCount('send')).toBe(0);
  });

  it('still rejects the leaking pass while its concurrent sibling stays clean', async () => {
    // Teeth under concurrency: a runner whose close leaves its pinned
    // listeners on the transport (while reporting closed) must reject its
    // OWN pass — and the sibling pass overlapping it must not misattribute
    // the leaked listeners as its own residue (the registry keeps them
    // attributed to the pass that pinned them).
    const fake = harness();
    const leakGate = defer();
    const siblingGate = defer();
    const leak = withFreshRunner(
      {
        ssrEnvironment: fake.environment,
        createServerModuleRunner: () => {
          // Pins like the real runner, then reports closed while leaving
          // every pinned listener on the transport.
          for (let i = 0; i < 3; i += 1) fake.emitter.on('send', () => {});
          return {
            import: async () => ({}),
            close: async () => {},
            isClosed: () => true,
          };
        },
      },
      async () => leakGate.promise.then(() => 'leak'),
    );
    const sibling = withFreshRunner(
      { createServerModuleRunner: fake.createServerModuleRunner, ssrEnvironment: fake.environment },
      async () => siblingGate.promise.then(() => 'sibling'),
    );
    leakGate.resolve();
    await expect(leak).rejects.toMatchObject({
      code: 'runner-cleanup',
      details: { residue: 'send-listeners' },
    });
    siblingGate.resolve();
    await expect(sibling).resolves.toMatchObject({ result: 'sibling' });
  });

  it('rejects send listeners that appeared across the pass and belong to no in-flight pass', async () => {
    // Teeth for foreign growth: anything that pins a send listener during
    // the pass and leaves it there — other than a registered concurrent
    // fresh-runner pass — is unattributable transport growth and rejects
    // exactly like the pass's own leak.
    const fake = harness();
    const rejection = await withFreshRunner(
      { createServerModuleRunner: fake.createServerModuleRunner, ssrEnvironment: fake.environment },
      async () => {
        fake.emitter.on('send', () => {});
        return 'ok';
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      code: 'runner-cleanup',
      details: { residue: 'send-listeners' },
    });
    expect((rejection as AdapterError).message).toContain('no fresh-runner pass owns');
  });

  it('returns to a clean baseline after concurrent passes fully unwind', async () => {
    // Registry hygiene: once concurrent passes settle, a later pass over
    // the same transport observes a fully restored baseline — released
    // registrations never over-exempt: a lingering one can only widen the
    // foreign scan's allowance, never cause a verdict — the leg's value is the
    // restored emitter baseline plus a clean later pass.
    const fake = harness();
    const gate = defer();
    const first = withFreshRunner(
      { createServerModuleRunner: fake.createServerModuleRunner, ssrEnvironment: fake.environment },
      async () => gate.promise.then(() => 'first'),
    );
    const second = withFreshRunner(
      { createServerModuleRunner: fake.createServerModuleRunner, ssrEnvironment: fake.environment },
      async () => 'second',
    );
    await second;
    gate.resolve();
    await first;
    const outcome = await withFreshRunner(
      { createServerModuleRunner: fake.createServerModuleRunner, ssrEnvironment: fake.environment },
      async () => 'later',
    );
    expect(outcome.evidence).toEqual({
      sendListenersBefore: 0,
      sendListenersAfterClose: 0,
      closedAfterClose: true,
    });
  });
});
