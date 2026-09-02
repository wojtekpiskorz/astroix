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

/** A fake runner that mirrors the real pin discipline: close() removes the send listener. */
class FakeRunner {
  closed = false;
  readonly listenersPinned: number;

  constructor(
    private readonly emitter: EventEmitter,
    private readonly behavior: { readonly surviveClose?: boolean } = {},
  ) {
    this.listenersPinned = 3;
    for (let i = 0; i < this.listenersPinned; i += 1) {
      this.emitter.on('send', () => {});
    }
  }

  async import(): Promise<unknown> {
    return {};
  }

  async close(): Promise<void> {
    if (this.behavior.surviveClose) return;
    for (const listener of this.emitter.listeners('send').slice(0, this.listenersPinned)) {
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
