import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';

/**
 * The fixture-entry restore shared by the content specs: since the auto-write
 * loop (#74) every pane edit persists, a spec that edits an entry restores it
 * before the next test. Since #114 the restore settles first: it waits until
 * the entry file and astro's data-store have been quiet together for longer
 * than the write debounce, and only then writes the original bytes — a
 * restore whose writeFileSync overtook an armed debounce let the late write
 * re-dirty the file after it, with no later restore to catch the leak.
 *
 * The settle waits for quiet, not for the edit's markers: the same helper
 * guards non-editing tests (content-form/body-editor afterEach), where no
 * marker would ever appear, and an edit can only remove pristine strings
 * (scratch's whole-draft raw field). Any armed write must land as a file or
 * store change before the quiet window can close, so sustained silence means
 * nothing is armed — which is exactly "the test's edit is visible in the
 * store, or never existed". Both files are read whole: a same-length splice
 * would hide from a size-only signature.
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
// comfortably past use-auto-write.ts's ~300ms debounce plus the write's
// landing; every restore pays it once, so it stays lean
const QUIET_MS = 3_000;
const SETTLE_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function readStore(): string {
  try {
    return readFileSync(STORE, 'utf8');
  } catch {
    return '';
  }
}

/** Waits out any armed auto-write: file+store silent together for QUIET_MS. */
async function settleWrites(file: string): Promise<void> {
  const readSignature = () => `${readFileSync(file, 'utf8')}\u0000${readStore()}`;
  const start = Date.now();
  let signature = readSignature();
  let lastChange = Date.now();
  while (Date.now() - lastChange < QUIET_MS) {
    if (Date.now() - start >= SETTLE_TIMEOUT_MS) {
      throw new Error(
        `fixture writes never settled: ${file} or the data-store kept changing for ${SETTLE_TIMEOUT_MS}ms`,
      );
    }
    await sleep(POLL_MS);
    const next = readSignature();
    if (next !== signature) {
      signature = next;
      lastChange = Date.now();
    }
  }
}

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
  await settleWrites(file);
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
