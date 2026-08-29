import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';

/**
 * The fixture-entry restore shared by the content specs: since the auto-write
 * loop (#74) every pane edit persists, a spec that edits an entry restores it
 * before the next test. The restore waits until astro's own data-store file
 * reflects pristine content — canvas pages render from that store, so a
 * lagging sync would leak the test's edit into the next spec.
 *
 * The wait reads the store file only (zero server load — each /collections
 * request spins a fresh module runner, and polling it hard enough wedges the
 * dev server), and matches on its flattened value pool: `absent` strings are
 * what the test wrote, `present` what only pristine content carries. When a
 * test's write+restore collapse inside one sync window the store never sees
 * the edit at all — the markers pass immediately, correctly.
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
