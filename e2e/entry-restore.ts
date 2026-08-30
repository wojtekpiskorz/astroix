import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { settleWrites } from './settle-writes';

/**
 * The fixture-entry restore shared by the content specs: since the auto-write
 * loop (#74) every pane edit persists, a spec that edits an entry restores it
 * before the next test. Since #114 the restore settles first: it waits until
 * the entry file and astro's data-store have been quiet together for longer
 * than the write debounce (the shared mechanism, with its quiet-over-markers
 * rationale, lives in settle-writes.ts — #128 lifted it there when the pack
 * lane needed the same guard), and only then writes the original bytes.
 *
 * The post-restore wait reads the store file only (zero server load — each
 * /collections request spins a fresh module runner, and polling it hard
 * enough wedges the dev server), and matches on its flattened value pool:
 * `absent` strings are what the test wrote, `present` what only pristine
 * content carries. When a test's write+restore collapse inside one sync
 * window the store never sees the edit at all — the markers pass
 * immediately, correctly.
 */

const STORE = join('e2e', 'fixture', '.astro', 'data-store.json');

export interface RestoreProbe {
  /** Strings the store pool must contain (pristine-only markers). */
  present?: readonly string[];
  /** The test's written strings the store pool must no longer contain. */
  absent?: readonly string[];
}

export async function restoreEntry(
  file: string,
  original: string,
  probe: RestoreProbe = {},
): Promise<void> {
  await settleWrites([file, STORE]);
  writeFileSync(file, original);
  await expect
    .poll(
      () => {
        try {
          const store = readFileSync(STORE, 'utf8');
          return (
            (probe.present ?? []).every((marker) => store.includes(marker)) &&
            (probe.absent ?? []).every((marker) => !store.includes(marker))
          );
        } catch {
          return false;
        }
      },
      { timeout: 30_000, intervals: [200, 500, 1000] },
    )
    .toBeTruthy();
}
