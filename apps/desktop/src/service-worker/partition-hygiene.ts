/**
 * The post-unload partition hygiene (#247, H5; ADR-0009 "after the old
 * target unloads, its Service Worker registrations and Cache Storage
 * are cleared. The attached bypass remains the authority invariant —
 * cleanup alone would not be"): the defense-in-depth pass that runs
 * ONLY after the old editing target has unloaded, never beside a live
 * one — a cleanup that raced a live page could be re-poisoned behind
 * it, and a cleanup offered AS the security claim is the antipattern
 * the ticket forbids.
 *
 * The ordering law is the module's whole shape: the unload observation
 * is awaited BEFORE the storage clear is issued, and the clear touches
 * exactly the Service Worker surface — `serviceworkers` (every
 * registration on the partition) and `cachestorage` (the worker's
 * poisoned caches) — never any other storage. The live bypass invariant
 * lives in `../main/debugger-guard.ts`; this pass replaces nothing.
 *
 * Electron-free beyond the structural seam: the composition passes the
 * real partition session's `clearStorageData`; the focused units pass a
 * fake; the real-partition truth is the `e2e/desktop` lane.
 */

/** The storages the hygiene pass clears — the SW surface and its caches, nothing else. */
export const PARTITION_HYGIENE_STORAGES: readonly string[] = ['serviceworkers', 'cachestorage'];

/**
 * The structural slice of the partition `Session` the pass needs —
 * `Session['clearStorageData']` satisfies it unchanged.
 */
export interface PartitionStorageSeam {
  clearStorageData(options: { readonly storages: readonly string[] }): Promise<void>;
}

/** What the hygiene pass did — honest failure stages, never a silent skip. */
export type HygieneReport =
  | { readonly ok: true; readonly storages: readonly string[] }
  | { readonly ok: false; readonly stage: 'unload' | 'clear'; readonly detail: string };

/**
 * Clears the partition's Service Worker state strictly after
 * `awaitUnload` settles. The unload observation is expected to be the
 * target window's real unload event (the composition builds it); a
 * hang there hangs the pass — fail-safe, since a premature clear is
 * the one error this law forbids.
 */
export async function clearServiceWorkerStateAfterUnload(options: {
  readonly storage: PartitionStorageSeam;
  readonly awaitUnload: Promise<void>;
}): Promise<HygieneReport> {
  try {
    await options.awaitUnload;
  } catch (error) {
    return {
      ok: false,
      stage: 'unload',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    await options.storage.clearStorageData({ storages: PARTITION_HYGIENE_STORAGES });
  } catch (error) {
    return {
      ok: false,
      stage: 'clear',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, storages: [...PARTITION_HYGIENE_STORAGES] };
}
