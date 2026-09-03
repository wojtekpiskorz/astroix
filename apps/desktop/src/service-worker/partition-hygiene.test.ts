import { describe, expect, it } from 'vitest';
import {
  clearServiceWorkerStateAfterUnload,
  PARTITION_HYGIENE_STORAGES,
  type PartitionStorageSeam,
} from './partition-hygiene.ts';

/**
 * The post-unload hygiene laws (#247, H5): the clear runs strictly
 * AFTER the unload observation settles, touches exactly the Service
 * Worker storages, and reports failures honestly. Deterministic
 * fakes; the real-partition truth is the `e2e/desktop` lane.
 */

/** The recording fake: the clear is deferred until the test releases it. */
function fakeStorage(): {
  seam: PartitionStorageSeam;
  clearCalls(): { storages: readonly string[] }[];
  failNext(error: Error): void;
} {
  const calls: { storages: readonly string[] }[] = [];
  const failures: Error[] = [];
  return {
    seam: {
      clearStorageData: async (options) => {
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        calls.push({ storages: [...options.storages] });
      },
    },
    clearCalls: () => calls,
    failNext: (error) => {
      failures.push(error);
    },
  };
}

describe('clearServiceWorkerStateAfterUnload — the after-unload ordering law', () => {
  it('clears exactly the Service Worker storages once the unload settles', async () => {
    const storage = fakeStorage();
    let settleUnload: (() => void) | null = null;
    const report = clearServiceWorkerStateAfterUnload({
      storage: storage.seam,
      awaitUnload: new Promise<void>((resolve) => {
        settleUnload = resolve;
      }),
    });
    // Before the unload settles: no clear has been issued.
    await Promise.resolve();
    expect(storage.clearCalls()).toHaveLength(0);
    (settleUnload as (() => void) | null)?.();
    expect(await report).toEqual({ ok: true, storages: PARTITION_HYGIENE_STORAGES });
    expect(PARTITION_HYGIENE_STORAGES).toEqual(['serviceworkers', 'cachestorage']);
    expect(storage.clearCalls()).toEqual([{ storages: ['serviceworkers', 'cachestorage'] }]);
  });

  it('reports a rejected unload observation honestly (stage unload, no clear)', async () => {
    const storage = fakeStorage();
    const report = await clearServiceWorkerStateAfterUnload({
      storage: storage.seam,
      awaitUnload: Promise.reject(new Error('unload observation failed')),
    });
    expect(report).toEqual({ ok: false, stage: 'unload', detail: 'unload observation failed' });
    expect(storage.clearCalls()).toHaveLength(0);
  });

  it('reports a failed clear honestly (stage clear)', async () => {
    const storage = fakeStorage();
    storage.failNext(new Error('partition session gone'));
    const report = await clearServiceWorkerStateAfterUnload({
      storage: storage.seam,
      awaitUnload: Promise.resolve(),
    });
    expect(report).toEqual({ ok: false, stage: 'clear', detail: 'partition session gone' });
  });
});
