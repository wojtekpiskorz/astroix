import { readFileSync } from 'node:fs';

/**
 * The quiet-settle behind the e2e restores (#114 family): before a spec
 * writes pristine bytes back over a chrome-edited file, it waits until the
 * watched files have been quiet together for longer than the write debounce
 * (~300ms in both verticals' auto-write loops) — a restore whose
 * writeFileSync overtook an armed debounce let the late write re-dirty the
 * file after it, with no later restore to catch the leak.
 *
 * The settle waits for quiet, not for the edit's markers: the same helper
 * guards non-editing tests (content-form/body-editor afterEach), where no
 * marker would ever appear, and an edit can only remove pristine strings
 * (scratch's whole-draft raw field). Any armed write must land as a change
 * in some watched file before the quiet window can close, so sustained
 * silence means nothing is armed — which is exactly "the test's edit has
 * landed, or never existed". What a lane watches is its write mirror: the
 * main fixture settles entry file + astro's data-store (extracted callers
 * pass both); the pack lane watches the edited page alone, its fixture
 * having no content collections to maintain a store. Every file is read
 * whole and compared joined: a same-length splice would hide from a
 * size-only signature. A missing file reads as '' (the main fixture's
 * data-store before first boot).
 */

// comfortably past the ~300ms debounce plus the write's landing; every
// restore pays it once, so it stays lean
const QUIET_MS = 3_000;
const SETTLE_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function readFileTolerant(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Waits out any armed auto-write: all files silent together for QUIET_MS. */
export async function settleWrites(paths: readonly string[]): Promise<void> {
  const readSignature = () => paths.map((path) => readFileTolerant(path)).join('\u0000');
  const start = Date.now();
  let signature = readSignature();
  let lastChange = Date.now();
  while (Date.now() - lastChange < QUIET_MS) {
    if (Date.now() - start >= SETTLE_TIMEOUT_MS) {
      throw new Error(
        `fixture writes never settled: ${paths.join(', ')} kept changing for ${SETTLE_TIMEOUT_MS}ms`,
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
